const path = require('path')
const UglifyJSPlugin = require('uglifyjs-webpack-plugin')

module.exports = {
    entry: './lambdas/src/public/about.js',
    output: {
      path: '/tmp/',
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
  }