// blobStorage.js
const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME; 
const containerName = "supplier-documents";

const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  new DefaultAzureCredential()
);

const containerClient = blobServiceClient.getContainerClient(containerName);

module.exports = { containerClient };