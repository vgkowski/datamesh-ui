/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { Amplify, Auth } from "aws-amplify";
import { useEffect, useState } from "react";
import {GlueClient, GetDatabasesCommand} from '@aws-sdk/client-glue';
import { Box, Button, ButtonDropdown, Header, Link, SpaceBetween, Spinner, Table } from "@cloudscape-design/components";
import ResourceLFTagsComponent from "./TBAC/ResourceLFTagsComponent";
const cfnOutput = require("../cfn-output.json")
const config = Amplify.configure();
const axios = require("axios").default;

function CatalogComponent(props) {
    const [databases, setDatabases] = useState([]);
    const [response, setResponse] = useState(null);
    const [nextToken, setNextToken] = useState(null);
    const [refreshTrigger, setRefreshTrigger] = useState(0)
    const [spinnerVisibility, setSpinnerVisibility] = useState(false)

    useEffect(() => {
        async function run() {
            const credentials = await Auth.currentCredentials();
            const glue = new GlueClient({region: config.aws_project_region, credentials: Auth.essentialCredentials(credentials)});
            const results = await glue.send(new GetDatabasesCommand({NextToken: nextToken}));
            setDatabases(databases => databases.concat(results.DatabaseList));
            setResponse(results);
        }

        run()
    }, [refreshTrigger]);

    const refresh = async() => {
        setSpinnerVisibility(true)
        const currentSession = await Auth.currentSession();
        const refreshLfTagUrl = cfnOutput.InfraStack.WorkflowApiUrl + "/tags/sync-permissions";
        const refreshDataDomainPermissionsUrl = cfnOutput.InfraStack.WorkflowApiUrl + "/data-domains/sync-permissions";

        await Promise.all([
            axios({
                method: "POST",
                url: refreshLfTagUrl,
                headers: {
                    "Authorization": currentSession.getAccessToken().getJwtToken()
                }
            }),
            axios({
                method: "POST",
                url: refreshDataDomainPermissionsUrl,
                headers: {
                    "Authorization": currentSession.getAccessToken().getJwtToken()
                }
            })
        ])


        setDatabases([])
        setNextToken(null)
        setResponse(null)
        setRefreshTrigger(refreshTrigger + 1)
        setSpinnerVisibility(false)
    }

    const renderRefresh = () => {
        if (spinnerVisibility) {
            return (
                <Button disabled="true"><Spinner /> Refresh</Button>
            )
        } else {
            return (
                <Button iconName="refresh" onClick={refresh}>Refresh</Button>
            )
        }
    }

    return (
        <div>
            <Box margin={{top: "l"}}>
                <Table
                    footer={<Box textAlign="center" display={(response && response.NextToken) ? "block" : "none"}><Link variant="primary" onFollow={(event) => {setNextToken(response.NextToken);setRefreshTrigger(refreshTrigger + 1);} }>View More</Link></Box>}
                    columnDefinitions={[
                        {
                            header: "Name",
                            cell: item => <Link variant="primary" href={"/tables/"+item.Name}>{item.Name}</Link>

                        },
                        {
                            header: "Tags",
                            cell: item => <ResourceLFTagsComponent resourceType="database" resourceName={item.Name} />
                        },
                        {
                            header: "Owner",
                            cell: item => item.Parameters.data_owner_name + " ("+item.Parameters.data_owner+")"
                        },
                        {
                            header: "Actions",
                            cell: item => <ButtonDropdown expandToViewport="true" items={[
                                {text: "Register Data Product", href: `/product-registration/${item.Name}/new`},
                                {text: "View Tables", href: `/tables/${item.Name}`}
                            ]}>Actions</ButtonDropdown>
                        }
                    ]}

                    items={databases}
                    header={<Header variant="h2" actions={
                        <SpaceBetween direction="horizontal" size="s">
                            {renderRefresh()}
                        </SpaceBetween>
                    }>Data Domains</Header>}
                />
             </Box>
        </div>
    );
}

export default CatalogComponent;