#!/bin/bash

# Cleanup - Remove everything from the Lambda Blog

# Needs the Prefix. Either define it or use the one in
# install/lambda_config.json

if [[ -z prefix ]] ; then
  prefix=$(jq -r .lambda_prefix < install/lambda_config.json)
fi

if [[ -z region ]] ; then
	  region=$(jq -r .region < install/lambda_config.json)
fi

echo "Using region $region and prefix $prefix"
echo "To proceed, hit ENTER"
read a

echo "Not yet. Please do this manually"
exit 1

# Get DNS from CloudFront
# Find Id by Origins being "Custome-$prefix-"
cf_id=$(aws cloudfront list-distributions | jq -r '.DistributionList.Items[] | select(.Origins.Items[].Id | test("Custom-'$prefix'-.*")) | .Id')

dns_alias=$(aws cloudfront get-distribution --id=$cf_id | jq -r '.Distribution.DomainName')
# Get hosted zone ID
zone_id=$(aws route53 list-hosted-zones | jq -r '.HostedZones[] | select(.Name=="aws.qw2.org.") | .Id')
# List DNS records for aws.qw2.org
dns_record=$(aws route53 list-resource-record-sets --hosted-zone-id=$zone_id | jq -r '.ResourceRecordSets[] | select(.AliasTarget.DNSName == "'$dns_alias'") | .')
cat >/tmp/dnsupdate.json <<_EOF_
{
  "Comment": "Delete blog DNS alias",
  "Changes": [
    {
      "Action": "DELETE",
      "ResourceRecordSet": {
        "Name": "$dns_record.",
      }
    }
  ]
}
_EOF_

id=$(echo $id | awk -F/ '{print $3}')

aws route53 change-resource-record-sets --hosted-zone-id $id --change-batch "file:///tmp/dnsupdate.json" >/tmp/dnsupdate.out


# Remove CloudFront entry
etag=$(aws cloudfront get-distribution --id=$cf_id | jq -r .ETag)
# Disable CF Distribution first

# Then delete
aws cloudfront delete-distribution --id=$cf_id --if-match=$etag


# Remove S3 bucket
# Find by name "$prefix-"
aws s3 ls

aws s3 rm s3://${prefix}-${dns_record} --recursive
# Remove bucket
aws s3 rb s3://${prefix}-${dns_record}

# Remove Functions

aws lambda list-functions | jq -r '.Functions[] | select(.FunctionName | test("'$prefix'_")) | .FunctionName' >/tmp/functions.list

for i in $(cat /tmp/functions.list) ; do
	aws lambda delete-function --function-name="$i"
done


# Delete API Gateway

rest_api=$(aws apigateway get-rest-apis | jq -r '.items[] | select(.name=="'$prefix'") | .id')
aws apigateway delete-rest-api --rest-api-id $rest_api

# Remove role
# Might have permission problems...

aws iam delete-role --role-name=${prefix}_role

# Remove tables from DynamoDB

aws dynamodb list-tables | jq -r '.TableNames[] | select(. | test("'$prefix'_")) | .'
aws dynamodb delete-table --table-name=${prefix}_objects
aws dynamodb delete-table --table-name=${prefix}_posts



