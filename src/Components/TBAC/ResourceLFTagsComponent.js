import { GetResourceLFTagsCommand, LakeFormationClient } from "@aws-sdk/client-lakeformation";
import { useEffect, useState } from "react";
import {Amplify, Auth } from "aws-amplify";
import DisplayLFTagsComponent from "./DisplayLFTagsComponent";

const config = Amplify.configure();

function ResourceLFTagsComponent(props) {
    const [resourceTag, setResourceTag] = useState([]);
    const [databaseName, setDatabaseName] = useState(null);

    useEffect(() => {
        async function run() {
            const credentials = await Auth.currentCredentials();
            const lfClient = new LakeFormationClient({region: config.aws_project_region, credentials: Auth.essentialCredentials(credentials)});
            
            let payload = null;
    
            if (props.resourceType == "database") {
                payload = {
                    Resource: {
                        Database: {
                            Name: props.resourceName
                        }
                    }
                }
                setDatabaseName(props.resourceName);
            } else if (props.resourceType == "table") {
                payload = {
                    Resource: {
                        Table: {
                            DatabaseName: props.resourceDatabaseName,
                            Name: props.resourceName
                        }
                    }
                }
                setDatabaseName(props.resourceDatabaseName)
            }
    
            const responsePayload = await lfClient.send(new GetResourceLFTagsCommand(payload));
    
            let tags = null
            if (props.resourceType == "database") {
                tags = responsePayload["LFTagOnDatabase"]
            } else if (props.resourceType == "table") {
                tags = responsePayload["LFTagsOnTable"]
            }

            setResourceTag(tags);

            if (props.tagsCallback) {
                props.tagsCallback(tags)
            }
        }

        run()
    }, [props.forceReload]);

    return (
        <DisplayLFTagsComponent lfTags={resourceTag} database={databaseName} showDataDomain />
    );
}

export default ResourceLFTagsComponent;