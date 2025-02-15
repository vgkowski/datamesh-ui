const AWS = require("aws-sdk");

const DOMAIN_DATABASE_PREFIX = "data-domain"
const DOMAIN_BUS_NAME = 'data-mesh-bus';
const LF_MODE_TBAC = "tbac"
const LF_MODE_NRAC = "nrac"
const CONFIDENTIALITY_NON_SENSITIVE = "non-sensitive"
const CONFIDENTIALITY_SENSITIVE = "sensitive"
const UI_AUTH_ROLE_ARN = process.env.UI_AUTH_ROLE_ARN

const createOrUpdateLFTags = async(lfClient, key, values, targetRole, permissions) => {
    if (!targetRole) {
        targetRole = UI_AUTH_ROLE_ARN
    }

    if (!permissions) {
        permissions = "DESCRIBE"
    }

    if (key && values) {
        try {
            await lfClient.getLFTag({TagKey: key}).promise()
            await lfClient.updateLFTag({
                TagKey: key,
                TagValuesToAdd: values
            }).promise()
        } catch (e) {
            await lfClient.createLFTag({
                TagKey: key,
                TagValues: values
            }).promise()
        }
    }

    const refreshedTag = await lfClient.getLFTag({TagKey: key}).promise()

    await lfClient.grantPermissions({
        Permissions: [permissions],
        Principal: {
            DataLakePrincipalIdentifier: targetRole
        },
        Resource: {
            LFTag: {
                TagKey: refreshedTag.TagKey,
                TagValues: refreshedTag.TagValues
            }
        }
    }).promise()
}

exports.handler = async(event) => {
    const returnPayload = {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            'Access-Control-Allow-Origin': '*'
        }
    }
    const workflowRoleArn = process.env.WORKFLOW_ROLE_ARN
    const domainTagKey = process.env.DOMAIN_TAG_KEY
    const confidentialityTagKey = process.env.CONFIDENTIALITY_TAG_KEY
    const defaultConfidentiality = process.env.DEFAULT_CONFIDENTIALITY
    const {domainId, domainSecretArn, customLfTags} = JSON.parse(event.body)
    const lfModes = [LF_MODE_TBAC, LF_MODE_NRAC]
    const awsRegion = process.env.AWS_REGION
    const centralEventBusArn = process.env.CENTRAL_EVENT_BUS_ARN
    const centralEventBusName = centralEventBusArn.split("/")[1]
    const dataDomainBusArn = `arn:aws:events:${awsRegion}:${domainId}:event-bus/${DOMAIN_BUS_NAME}`

    const secretsManagerClient = new AWS.SecretsManager()
    const glueClient = new AWS.Glue()
    const iamClient = new AWS.IAM()
    const lfClient = new AWS.LakeFormation()
    const ebClient = new AWS.EventBridge()

    let SecretString, BucketName, Prefix, KmsKeyId, DomainName, domainName = null;

    const userClaims = event.requestContext.authorizer.jwt.claims

    try {
        const secretsResult = await secretsManagerClient.getSecretValue({SecretId: domainSecretArn}).promise()
        SecretString = secretsResult.SecretString
    } catch (e) {
        console.log(JSON.stringify(e))
        returnPayload.statusCode = 400
        returnPayload.body = JSON.stringify({"error": "Invalid data domain secret."})
        return returnPayload
    }

    ({DomainName, BucketName, Prefix, KmsKeyId} = JSON.parse(SecretString))

    domainName = DomainName

    const lambdaClient = new AWS.Lambda()
    await lambdaClient.invoke({
        FunctionName: process.env.ADJUST_RESOURCE_POLICY_FUNC_NAME,
        Payload: JSON.stringify({
            "accountId": domainId
        })
    }).promise()

    const validationCheck = await Promise.allSettled([
        glueClient.getDatabase({Name: `${LF_MODE_NRAC}-${DOMAIN_DATABASE_PREFIX}-${domainId}`}).promise(),
        glueClient.getDatabase({Name: `${LF_MODE_TBAC}-${DOMAIN_DATABASE_PREFIX}-${domainId}`}).promise()
    ])

    if (validationCheck[0].status == "fulfilled" || validationCheck[1].status == "fulfilled") {
        returnPayload.statusCode = 400
        returnPayload.body = JSON.stringify({"error": "Data domain has already been registered."})
        return returnPayload
    }

    const createRoleResult = await iamClient.createRole({
        RoleName: `${DOMAIN_DATABASE_PREFIX}-${domainId}-accessRole`,
        AssumeRolePolicyDocument: JSON.stringify({
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "lakeformation.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        })
    }).promise()

    // await iamClient.putRolePolicy({
    //     PolicyName: `AllowRoleAccess_${domainId}`,
    //     PolicyDocument: JSON.stringify({
    //         "Version": "2012-10-17",
    //         "Statement": [
    //             {
    //                 "Effect": "Allow",
    //                 "Action": [
    //                     "iam:GetRole",
    //                     "iam:PassRole"
    //                 ],
    //                 "Resource": [
    //                     createRoleResult.Role.Arn
    //                 ]
    //             }
    //         ]
    //     }),
    //     RoleName: process.env.LAMBDA_EXEC_ROLE_NAME
    // }).promise()

    for (let mode of lfModes) {
        const dbName = `${mode}-${DOMAIN_DATABASE_PREFIX}-${domainId}`;
        await glueClient.createDatabase({
            DatabaseInput: {
                Description: `Database for data products in ${domainName} data domain. Account id: ${domainId}. LF Access Control mode: ${mode}`,
                Name: dbName,
                LocationUri: `s3://${BucketName}/${Prefix}`,
                Parameters: {
                    data_owner: domainId,
                    data_owner_name: domainName,
                    pii_flag: "false",
                    access_mode: mode
                }
            }
        }).promise()

        await lfClient.grantPermissions({
            Permissions: ["ALL"],
            Principal: {
                DataLakePrincipalIdentifier: workflowRoleArn
            },
            Resource: {
                Database: {
                    Name: dbName
                }
            }
        }).promise()

        await lfClient.grantPermissions({
            Permissions: ["DESCRIBE"],
            Principal: {
                DataLakePrincipalIdentifier: UI_AUTH_ROLE_ARN
            },
            Resource: {
                Database: {
                    Name: dbName
                }
            }
        }).promise()
    }

    await createOrUpdateLFTags(lfClient, confidentialityTagKey, null, process.env.LAMBDA_EXEC_ROLE_ARN, "ASSOCIATE")

    await iamClient.putRolePolicy({
        PolicyName: "AllowDataAccess",
        PolicyDocument: JSON.stringify({
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": [
                        "s3:GetObject*",
                        "s3:GetBucket*",
                        "s3:List*",
                        "s3:DeleteObject*",
                        "s3:PutObject",
                        "s3:PutObjectLegalHold",
                        "s3:PutObjectRetention",
                        "s3:PutObjectTagging",
                        "s3:PutObjectVersionTagging",
                        "s3:Abort*",
                    ],
                    "Resource": [
                        `arn:aws:s3:::${BucketName}`,
                        `arn:aws:s3:::${BucketName}/${Prefix}/*`
                    ]
                }
            ]
        }),
        RoleName: `${DOMAIN_DATABASE_PREFIX}-${domainId}-accessRole`
    }).promise()

    if (KmsKeyId) {
        await iamClient.putRolePolicy({
            PolicyName: "AllowEncryptedDataAccess",
            PolicyDocument: JSON.stringify({
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            'kms:Encrypt*',
                            'kms:Decrypt*',
                            'kms:ReEncrypt*',
                            'kms:GenerateDataKey*',
                            'kms:Describe*'
                        ],
                        "Resource": [
                            `arn:aws:kms:${awsRegion}:${domainId}:key/${KmsKeyId}`
                        ]
                    }
                ]
            }),
            RoleName: `${DOMAIN_DATABASE_PREFIX}-${domainId}-accessRole`
        }).promise()
    }

    await lfClient.registerResource({
        ResourceArn: `arn:aws:s3:::${BucketName}/${Prefix}/*`,
        UseServiceLinkedRole: false,
        RoleArn: createRoleResult.Role.Arn
    }).promise()

    await createOrUpdateLFTags(lfClient, domainTagKey, [domainName])

    await lfClient.addLFTagsToResource({
        LFTags: [
            {
                TagKey: domainTagKey,
                TagValues: [domainName]
            },
            {
                TagKey: confidentialityTagKey,
                TagValues: [defaultConfidentiality]
            }
        ],
        Resource: {
            Database: {
                Name: `${LF_MODE_TBAC}-${DOMAIN_DATABASE_PREFIX}-${domainId}`
            }
        }
    }).promise()

    await lfClient.batchGrantPermissions({
        Entries: [
            {
                Id: 'GrantDomainTagAccess',
                Permissions: ["ASSOCIATE"],
                PermissionsWithGrantOption: ["ASSOCIATE"],
                Principal: {
                    DataLakePrincipalIdentifier: domainId
                },
                Resource: {
                    LFTag: {
                        TagKey: domainTagKey,
                        TagValues: [domainName]
                    }
                }
            },
            {
                Id: 'GrantConfidentialityTagAccess',
                Permissions: ["ASSOCIATE"],
                PermissionsWithGrantOption: ["ASSOCIATE"],
                Principal: {
                    DataLakePrincipalIdentifier: domainId
                },
                Resource: {
                    LFTag: {
                        TagKey: confidentialityTagKey,
                        TagValues: [CONFIDENTIALITY_NON_SENSITIVE, CONFIDENTIALITY_SENSITIVE]
                    }
                }
            },
            {
                Id: 'GrantTagBasedTableActions',
                Permissions: ["ALL"],
                PermissionsWithGrantOption: ["ALL"],
                Principal: {
                    DataLakePrincipalIdentifier: domainId
                },
                Resource: {
                    LFTagPolicy: {
                        ResourceType: "TABLE",
                        Expression: [
                            {
                                TagKey: domainTagKey,
                                TagValues: [domainName]
                            }
                        ]
                    }
                }
            },
            {
                Id: 'GrantTagBasedDBActions',
                Permissions: ["CREATE_TABLE", "DESCRIBE"],
                PermissionsWithGrantOption: ["CREATE_TABLE", "DESCRIBE"],
                Principal: {
                    DataLakePrincipalIdentifier: domainId
                },
                Resource: {
                    LFTagPolicy: {
                        ResourceType: "DATABASE",
                        Expression: [
                            {
                                TagKey: domainTagKey,
                                TagValues: [domainName]
                            }
                        ]
                    }
                }
            }
        ]
    }).promise()

    if (customLfTags && customLfTags.length > 0) {
        const finalCustomLfTags = []
        for (let customLfTag of customLfTags) {
            if (customLfTag.TagKey != domainTagKey && customLfTag.TagKey != confidentialityTagKey) {
                await createOrUpdateLFTags(lfClient, customLfTag.TagKey, customLfTag.TagValues);
                await createOrUpdateLFTags(lfClient, customLfTag.TagKey, null, process.env.LAMBDA_EXEC_ROLE_ARN, "ASSOCIATE")
                await lfClient.grantPermissions({
                    Permissions: ["ASSOCIATE"],
                    PermissionsWithGrantOption: ["ASSOCIATE"],
                    Principal: {
                        DataLakePrincipalIdentifier: domainId
                    },
                    Resource: {
                        LFTag: {
                            TagKey: customLfTag.TagKey,
                            TagValues: customLfTag.TagValues
                        }
                    }
                }).promise()

                finalCustomLfTags.push(customLfTag)
            }
        }

        if (finalCustomLfTags.length > 0) {
            await lfClient.addLFTagsToResource({
                LFTags: finalCustomLfTags,
                Resource: {
                    Database: {
                        Name: `${LF_MODE_TBAC}-${DOMAIN_DATABASE_PREFIX}-${domainId}`
                    }
                }
            }).promise()
        }
    }

    await ebClient.putPermission({
        EventBusName: centralEventBusName,
        StatementId: `AllowDataDomainAccToPutEvents_${domainId}`,
        Action: "events:PutEvents",
        Principal: domainId
    }).promise()

    await ebClient.putRule({
        Name: `${domainId}_createResourceLinks_rule`,
        EventBusName: centralEventBusName,
        EventPattern: JSON.stringify({
            "source": ["com.central.stepfunction"],
            "detail-type": [`${domainId}_createResourceLinks`]
        })
    }).promise()

    await ebClient.putTargets({
        Rule: `${domainId}_createResourceLinks_rule`,
        Targets: [
            {
                Id: `${domainId}_createResourceLinks_target`,
                Arn: dataDomainBusArn,
                RoleArn: process.env.EB_XACCOUNT_ROLE_ARN
            }
        ],
        EventBusName: centralEventBusName
    }).promise()

    const dynamodbClient = new AWS.DynamoDB()
    await dynamodbClient.putItem({
        TableName: process.env.USER_MAPPING_TABLE_NAME,
        Item: {
            "userId": {
                "S": userClaims.sub
            },
            "accountId": {
                "S": domainId
            },
            "role": {
                "S": "owner"
            }
        }
    }).promise()

    returnPayload.body = JSON.stringify({"status": "200 OK"})
    return returnPayload
}