var co = require("co");
var path = require("path");
var fs = require("fs");
var node_s3_client = require('s3');

var isThere = require("is-there");
var chalk = require('chalk');
var _ = require('lodash');

var MemoryFS = require("memory-fs");
var webpack = require("webpack");
const UglifyJSPlugin = require('uglifyjs-webpack-plugin')
var pass_generator = require('generate-password');
var uuid = require('uuid');

var zip = require("node-zip");

var Mocha = require('mocha');

var lambda_api_mappings = require('./install/install_Lambda_API_Gateway_mappings.json');

var api_gateway_definitions = require('./install/install_API_Gateway_definitions.json');
var installation_policy = require('./install/install_IAM_UserPolicy.json');
var role_policy = require('./install/install_IAM_RolePolicy.json');



co(function*(){

	var config = require('../install_config.js');

	var AWS = require('aws-sdk');
	AWS.config.loadFromPath(config.credentials_path);

	var iam = new AWS.IAM({apiVersion: '2010-05-08'});
	var lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
	var s3 = new AWS.S3({
		signatureVersion: 'v4',
		apiVersion: '2006-03-01'
	});
	var dynamodb = new AWS.DynamoDB({apiVersion: '2012-08-10'});
	var apigateway = new AWS.APIGateway({apiVersion: '2015-07-09'});
	var cloudfront = new AWS.CloudFront({apiVersion: '2016-09-07'});
	var route53 = new AWS.Route53({apiVersion: '2013-04-01'});
	var sts = new AWS.STS();

	var role_arn = yield new Promise(function(resolve, reject){
		iam.createRole({
		  AssumeRolePolicyDocument: JSON.stringify({
			   "Version" : "2012-10-17",
			   "Statement": [ {
			      "Effect": "Allow",
			      "Principal": {
			         "Service": [ "lambda.amazonaws.com" ]
			      },
			      "Action": [ "sts:AssumeRole" ]
			   } ]
			}),
		  RoleName: config.role_name
		}, function(err, data) {
		  if (err){
		  	if(err.code === "EntityAlreadyExists"){
		  		console.log(chalk.yellow(err));
				iam.getRole({
				  RoleName: config.role_name
				}, function(err, data) {
				  if (err) {
				  	console.log(chalk.red(err));
			  		console.log(err.stack);
			  		reject();
				  }else{
				  	resolve(data.Role.Arn);
				  }
				});
		  	}else{
		  		console.log(chalk.red(err));
		  		console.log(err.stack);
		  		reject();
		  	}
		  }else{
		  	resolve(data.Role.Arn);
		  }
		});
	});


	console.log();
	console.log(chalk.cyan("Getting user account ID"));
	var account_id = yield new Promise(function(resolve, reject){
		sts.getCallerIdentity({}, function(err, data) {
		   if (err){
		  	console.log(chalk.red(err));
		  	console.log(err.stack);
		  	reject()
		  }else{
		  	resolve(data.Account)
		  }
	 	});
	});

	console.log();
	console.log(chalk.cyan("Uploading Lambda functions & creating API gateway endpoints"));

	function getFiles(srcpath) {
	  return fs.readdirSync(srcpath).filter(function(file) {
	    return !fs.statSync(path.join(srcpath, file)).isDirectory();
	  });
	}

	function getEntries(){
	  var public_files = getFiles(path.join(__dirname, "./lambdas/src/public"))
	    .map(filename => {
	       return {
	       	name: filename,
	       	path: path.join(
		         path.join(__dirname, "./lambdas/src/public"),
		         filename
		    )
	       };
	     })

	  var admin_files = getFiles(path.join(__dirname, "./lambdas/src/admin"))
	    .map(filename => {
	       return {
	       	name: filename,
	       	path: path.join(
		         path.join(__dirname, "./lambdas/src/admin"),
		         filename
		    )
	       };
	     })
	  return public_files.concat(admin_files);
	}


	var entries = getEntries();
	for(var i = 0; i < entries.length; i++){
		yield new Promise(function(resolve, reject){
			var array = fs.readFileSync(entries[i].path).toString().split("\n");
			var first_line = array[0];
			var fn_name_without_prefix = first_line.substring(3).trim();
			var lambda_fn_name = config.lambda_prefix+"_"+fn_name_without_prefix;

			console.log("Creating lambda function: " + chalk.green(lambda_fn_name));

			var mfs = new MemoryFS();
			var compiler = webpack({
		    entry: entries[i].path,
		    output: {
						    path: __dirname,
		      libraryTarget: "commonjs2",
		      filename: "compiled.js"
		    },
		    externals: {
		      "aws-sdk": "aws-sdk"
		    },
		    target: "node",

		    module: {
		      loaders: [{
		        test: /\.json$/,
		        loader: 'json'
		      }]
		    },
		    plugins: [
		    	new UglifyJSPlugin({
		    		uglifyOptions: {
		    			output: {
		    				beautify: false,
		    				semicolons: false
		    			},
		    			mangle: false
		    		}
		    	})
		    	]
		  }, function(err, stats) {
			    if (err){
				  	console.log(chalk.red(err));
				  	console.log(err);
				  }
			});
			compiler.outputFileSystem = mfs;

			compiler.run(function(err, stats) {
				var zip = new JSZip();

				zip.file(entries[i].name, mfs.readFileSync(__dirname+"/"+"compiled.js"));
				var data = zip.generate({type:"uint8array", compression: 'deflate'});

			  	var params = {
				  Code: {
				    ZipFile: data
				  },
				  FunctionName: lambda_fn_name,
				  Handler: path.basename(entries[i].name, '.js')+".handler",
				  Role: role_arn,
				  Runtime: "nodejs4.3",
				  //Description: 'STRING_VALUE',
				  MemorySize: 512,
				  Publish: true,
				  Timeout: 10
				};

				lambda.createFunction(params, function(err, data) {
				  if (err){
				  	if(err.code == "ResourceConflictException"){
				  		console.log(chalk.yellow(err));
				  		lambda.getFunction({
						  FunctionName: lambda_fn_name
						}, function(err, data) {
						  if (err) {
						  	console.log(chalk.red(err));
					  		console.log(err.stack);
						  }else{
						  	lambda.addPermission({
							  Action: 'lambda:*',
							  FunctionName: lambda_fn_name,
							  Principal: 'apigateway.amazonaws.com',
							  StatementId: uuid.v4(),
							}, function(err, data) {
							  if (err) {
								console.log(chalk.red(err));
  								console.log(err, err.stack); // an error occurred
  								reject();
							  }else{
							  	//console.log(JSON.parse(data.Statement).Resource);
							  	lambda_api_mappings[fn_name_without_prefix].lambda_arn = JSON.parse(data.Statement).Resource;
						  		resolve();
							  }
							});
						  }
						});
				  	}else{
				  		console.log(chalk.red(err));
				  		console.log(err.stack);
				  	}
				  }else{
					lambda.addPermission({
					  Action: 'lambda:*',
					  FunctionName: lambda_fn_name,
					  Principal: 'apigateway.amazonaws.com',
					  StatementId: uuid.v4(),
					}, function(err, data) {
					  if (err) {
						console.log(chalk.red(err));
  						console.log(err, err.stack); // an error occurred
  						reject();
					  }else{
					  	//console.log(data);
					  	lambda_api_mappings[fn_name_without_prefix].lambda_arn = JSON.parse(data.Statement).Resource;
				  		resolve();
					  }
					});
				  }
				});
			});
		});
	}

	


	process.exit();

}).catch(function(err){
	console.log(err);
	process.exit();
});
