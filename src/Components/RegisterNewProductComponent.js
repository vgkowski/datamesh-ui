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
import { GetDatabaseCommand, GlueClient } from "@aws-sdk/client-glue";
import { Box, Button, Container, Form, FormField, Header, Input, Select, SpaceBetween, Table, Icon, Alert, ColumnLayout, BreadcrumbGroup, Spinner, Modal, ContentLayout } from "@cloudscape-design/components";
import {Amplify, Auth } from "aws-amplify";
import {useEffect, useState} from 'react';
import { useNavigate, useParams } from "react-router";
import {v4 as uuid} from 'uuid';
import DataDomain from "../Backend/DataDomain";
import AuthWorkflow from "../Backend/AuthWorkflow";
import ResourceLFTagsComponent from "./TBAC/ResourceLFTagsComponent";
import ValueWithLabel from "./ValueWithLabel";
import RouterAwareBreadcrumbComponent from "./RouterAwareBreadcrumbComponent";
const cfnOutput = require("../cfn-output.json");
const axios = require("axios").default;

const config = Amplify.configure();
const dpmStateMachineArn = cfnOutput.InfraStack.DPMStateMachineArn;

function RegisterNewProductComponent(props) {
    const {domainId} = useParams()
    const [error, setError] = useState();
    const [database, setDatabase] = useState(null)
    const [products, setProducts] = useState([{"id": uuid(), "name": "", "location": "", "error": "", "nameError": "", "firstRow": true}])
    const [spinnerVisible, setSpinnerVisible] = useState(false)
    const [owner, setOwner] = useState(false)
    const [modalVisible, setModalVisible] = useState(false)
 
    // const onCancel = () => {
    //     window.location.href="/product-registration/list";
    // }

    const navigate = useNavigate()

    useEffect(() => {
        if (props.breadcrumbsCallback) {
            props.breadcrumbsCallback(
                <RouterAwareBreadcrumbComponent items={[
                    { text: "Data Domains", href: "/"},
                    { text: domainId, href: `/tables/${domainId}`},
                    { text: "Register New Data Products" }
                ]} />
            )
        }
    }, [])

    const addProductRow = () => {
        setProducts([...products, {"id": uuid(), "name": "", "location": "", "error": "", "nameError": "", "firstRow": false}])
    }

    const removeProductRow = (id) => {
        setProducts(products.filter(p => p.id != id))
    }

    const updateField = (id, fieldName, value) => {
        const index = products.findIndex(p => p.id == id);
        products[index][fieldName] = value;
        setProducts([...products]);
    }

    const onShowModal = async() => {
        if (database && isProductListValid()) {
            setModalVisible(true)
        } else {
            setError("Missing required fields.");
            setModalVisible(false)
        }
    }

    const onSubmit = async() => {
        if (database && isProductListValid()) {
            setModalVisible(false)
            setSpinnerVisible(true)
            const credentials = await Auth.currentCredentials();
            const isPathValid = await isS3PathsValid(credentials)

            if (isPathValid) {
                const accessMode = (database.Database.Parameters && database.Database.Parameters.access_mode) ? database.Database.Parameters.access_mode : "nrac";
                const formattedProducts = products.map((prod) => {
                    if (prod.location.startsWith("/")) {
                        prod.location = `${database.Database.LocationUri}${prod.location}`
                    } else {
                        prod.location = `${database.Database.LocationUri}/${prod.location}`
                    }
                    
                    prod.location_key = prod.location.substring(5);
                    
                    return prod;
                })

                const input = JSON.stringify({
                    "producer_acc_id": database.Database.Parameters.data_owner,
                    "database_name": domainId,
                    "lf_access_mode": accessMode,
                    "tables": formattedProducts
                })

                try {
                    await AuthWorkflow.exec(dpmStateMachineArn, input, database.Database.Parameters.data_owner)
                } catch (e) {
                    setSpinnerVisible(false)
                    setError("An unexpected error has occurred, please try again")
                }
                
   
                navigate(`/tables/${domainId}`)
            } else {
                setSpinnerVisible(false)
            }
        } else {
            setError("Missing required fields.");
        }
    }

    const isS3PathsValid = async() => {
        let isValid = true
        const tempProducts = []
        const pathTokenized = database.Database.LocationUri.split("/")
        const bucket = pathTokenized[2]
        const locationTopLevelPrefix = pathTokenized[3]
        const validateProductsPayload = {
            "bucket": bucket,
            "products": []
        }
        for (const prod of products) {
            const nameLength = prod.name.length

            if (nameLength < 1 || nameLength > 255) {
                isValid = false
                prod.nameError = "Invalid name. Must be between 1 and 255 characters long."
            }

            if (!prod.location.endsWith("/")) {
                isValid = false;
                prod.error = "Invalid path. Path should reference a folder not an object."
            } else {
                let prodPrefix = null;

                if (prod.location.startsWith("/")) {
                    prodPrefix = locationTopLevelPrefix+prod.location
                } else {
                    prodPrefix = locationTopLevelPrefix+"/"+prod.location
                }
                

                validateProductsPayload.products.push({
                    prefix: prodPrefix,
                    id: prod.id
                })
            }

            tempProducts.push(prod)
        }

        if (!isValid) {
            setProducts(tempProducts)
        } else {
            const validateUrl  =`${cfnOutput.InfraStack.WorkflowApiUrl}/data-products/validate`
            const session = await Auth.currentSession()
            
            const response = await axios({
                method: "POST",
                url: validateUrl,
                headers: {
                    "Authorization": session.getAccessToken().getJwtToken(),
                    "Content-Type": "application/json"
                },
                data: validateProductsPayload
            })

            const validateData = response.data

            isValid = validateData.valid

            if (!isValid) {
                const prodMap = validateData.products
                const validatedProducts = products.map((row) => {
                    const validationDetails = prodMap[row.id]

                    if (validationDetails.error) {
                        row.error = validationDetails.error
                    }

                    return row
                })

                setProducts(validatedProducts)
            }
        }

        return isValid;
    }

    const isProductListValid = () => {
        for (const p of products) {
            if (!p.name || p.name.length == 0 || !p.location || p.location.length == 0 || p.location.startsWith("s3://")) {
                return false;
            }
        }

        return true;
    }

    const renderDatabaseDetails = () => {
        if (database) {
            return (
                <ColumnLayout columns={2} variant="text-grid">
                    <SpaceBetween size="m">
                        <ValueWithLabel label="Data Domain">
                            {database.Database.Name}
                        </ValueWithLabel>
                        <ValueWithLabel label="Location">
                            {database.Database.LocationUri}
                        </ValueWithLabel>
                    </SpaceBetween>
                    <SpaceBetween size="m">
                        <ValueWithLabel label="Data Owner">
                            {(database.Database.Parameters && "data_owner_name" in database.Database.Parameters) ? database.Database.Parameters.data_owner_name : "n/a"}
                        </ValueWithLabel>
                        <ValueWithLabel label="Data Owner Account ID">
                            {(database.Database.Parameters && "data_owner" in database.Database.Parameters) ? database.Database.Parameters.data_owner : "n/a"}   
                        </ValueWithLabel>
                        <ValueWithLabel label="Tags">
                            <ResourceLFTagsComponent resourceType="database" resourceName={database.Database.Name} />
                        </ValueWithLabel>
                    </SpaceBetween>
                </ColumnLayout>   
            )
        }

        return (
            <Alert header="Object Not Found" type="error">
                The requested Data Domain object can't be found. Please go back to the previous page.
            </Alert>
        )
    }

    useEffect(() => {
        (async function run() {
            
            const credentials = await Auth.currentCredentials()
            const glueClient = new GlueClient({region: config.aws_project_region, credentials: Auth.essentialCredentials(credentials)})
            const dbResult = await glueClient.send(new GetDatabaseCommand({Name: domainId}))
            setDatabase(dbResult)

            if (dbResult) {
                setOwner(await DataDomain.isOwner(dbResult.Database.Parameters.data_owner))
            }
        })()
    }, [])

    const renderSubmit = () => {
        if (spinnerVisible) {
            return (
                <Button disabled="true"><Spinner /> Submit</Button>
            )
        } else {
            return (
                <Button variant="primary" onClick={() => onShowModal()} disabled={!database || !owner}>Submit</Button>
            )
        }
    }

    const renderProductList = () => {
        const prodList = products.map((product) => {
            return (
                <li><strong>Name:</strong> {product.name}, <strong>Location:</strong> {product.location}</li>
            )
        })

        return prodList
    }

    return (
        <ContentLayout header={
            <Header variant="h1">Register Data Products into Data Domain</Header>
        }>
        <Box>
            <Box margin={{top: "m"}}>
                <Form errorText={error} actions={
                    <SpaceBetween direction="horizontal" size="s">
                        <Button variant="link" onClick={(event) => {
                            event.preventDefault()
                            navigate(`/tables/${domainId}`)
                        }} disabled={spinnerVisible}>Cancel</Button>
                        {renderSubmit()}
                    </SpaceBetween>
                }>
                    <Box margin={{top: "m"}}>
                        <Container header={
                            <Header variant="h3">Data Domain Details</Header>
                        }>
                            {renderDatabaseDetails()}
                        </Container>
                    </Box>
                    <Box margin={{top: "m"}}>
                        <Table footer={<Button onClick={() => addProductRow()}><Icon name="add-plus" /> Add</Button>} header={<Header variant="h3">Products</Header>} columnDefinitions={[
                            {
                                header: "Name",
                                cell: e => <FormField errorText={e.nameError} constraintText="Not less than 1 or more than 255 bytes long."><Input type="text" placeholder="Enter Name" value={e.name} onChange={(event) => updateField(e.id, "name", event.detail.value)} /></FormField>
                            },
                            {
                                header: "S3 Location (Prefix)",
                                cell: e => <FormField constraintText={(database) ? `Input folder path relative to ${database.Database.LocationUri}. Path must end with /` : ""} errorText={e.error}><Input type="text" value={e.location}  onChange={(event) => updateField(e.id, "location", event.detail.value)} /></FormField>
                            },
                            {
                                header: "",
                                cell: e => (!e.firstRow) ? <Button onClick={() => removeProductRow(e.id)}><Icon name="close" /> Remove</Button>: null
                            }
                        ]} items={products}></Table>
                    </Box>
                </Form>
                <Modal size="medium" onDismiss={() => setModalVisible(false)} visible={modalVisible} footer={
                    <Box float="right">
                        <SpaceBetween direction="horizontal" size="s">
                            <Button onClick={() => setModalVisible(false)} variant="link">Cancel</Button>
                            <Button onClick={() => onSubmit()} variant="primary">Confirm</Button>
                        </SpaceBetween>
                    </Box>
                }>
                    <Header variant="h3">Registration Confirmation</Header>
                    You're registering the following data products in the <strong>{domainId}</strong> domain:
                    <ul>
                        {renderProductList()}
                    </ul>
                </Modal>
            </Box>
        </Box>
        </ContentLayout>

    );
}

export default RegisterNewProductComponent;