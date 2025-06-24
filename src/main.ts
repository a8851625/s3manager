/**
 * Deno S3 Manager Backend
 * * This server acts as a proxy between the frontend and AWS S3,
 * * and also serves the static index.html file.
 * * To run this server:
 * deno run --allow-net --allow-read --allow-write backend.ts
 */

// Import necessary modules from Deno standard library and third-party modules.
import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand
} from "https://esm.sh/@aws-sdk/client-s3@3.835.0";
import { Upload } from "https://esm.sh/@aws-sdk/lib-storage@3.835.0";

const app = new Application();
const router = new Router();

// --- Helper Function ---
// Creates an S3 client instance from the configuration object sent by the frontend.
const createS3Client = (config: any) => {
  if (!config || !config.region || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("Missing AWS configuration. Region, Access Key, and Secret Key are required.");
  }

  const clientConfig: any = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };

  // If a custom endpoint is provided (for S3-compatible storage like MinIO), set it.
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
    // forcePathStyle is often required for S3-compatible services.
    clientConfig.forcePathStyle = true; 
  }

  return new S3Client(clientConfig);
};

// --- API Routes ---

router.prefix('/api'); // Set a prefix for all API routes

// Route to test the connection by trying to list buckets.
router.post("/connect", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: 'json' }).value;
    const s3Client = createS3Client(body.config);
    await s3Client.send(new ListBucketsCommand({})); // A simple command to verify credentials
    ctx.response.body = { success: true, message: "Connection successful" };
  } catch (error) {
    console.error("Connection test failed:", error);
    ctx.response.status = 400; // Bad Request, likely due to bad credentials
    ctx.response.body = { success: false, error: error.message };
  }
});

// Route to list all S3 buckets.
router.post("/buckets", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: 'json' }).value;
    const s3Client = createS3Client(body.config);
    const data = await s3Client.send(new ListBucketsCommand({}));
    ctx.response.body = { buckets: data.Buckets || [] };
  } catch (error) {
    console.error("List buckets failed:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: error.message };
  }
});

// Route to list objects and common prefixes (folders) within a bucket.
router.post("/objects", async (ctx) => {
    try {
        const body = await ctx.request.body({ type: 'json' }).value;
        const { config, bucket, prefix } = body;
        const s3Client = createS3Client(config);
        const command = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/', // This is crucial to group objects into "folders"
        });
        const data = await s3Client.send(command);
        ctx.response.body = {
            contents: data.Contents || [],
            commonPrefixes: data.CommonPrefixes || []
        };
    } catch (error) {
        console.error("List objects failed:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: error.message };
    }
});

// Route to create a new bucket.
router.post("/buckets/create", async (ctx) => {
    try {
        const body = await ctx.request.body({ type: 'json' }).value;
        const { config, bucketName, region } = body;
        const s3Client = createS3Client(config);
        const command = new CreateBucketCommand({
            Bucket: bucketName,
            // For regions other than us-east-1, LocationConstraint must be specified.
            CreateBucketConfiguration: region !== 'us-east-1' ? { LocationConstraint: region } : undefined,
        });
        await s3Client.send(command);
        ctx.response.body = { success: true, message: `Bucket ${bucketName} created.` };
    } catch (error) {
        console.error("Create bucket failed:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: error.message };
    }
});

// Route to create a new folder (by creating a zero-byte object with a trailing slash).
router.post("/folders/create", async (ctx) => {
    try {
        const body = await ctx.request.body({ type: 'json' }).value;
        const { config, bucket, key } = body;
        const s3Client = createS3Client(config);
        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: key, // The key should end with a "/" e.g., "my-folder/"
            Body: '',
        });
        await s3Client.send(command);
        ctx.response.body = { success: true, message: `Folder ${key} created.` };
    } catch (error) {
        console.error("Create folder failed:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: error.message };
    }
});

// Route to handle file uploads using the recommended @aws-sdk/lib-storage Upload utility.
router.post("/upload", async (ctx) => {
    try {
        const body = ctx.request.body({ type: 'form-data' });
        const formDataReader = await body.value;
        const formData = await formDataReader.read({maxFileSize: 100 * 1024 * 1024}); // Set max file size e.g. 100MB
        
        console.log("\n--- New Upload Request ---");
        const config = JSON.parse(formData.fields.config);
        const bucket = formData.fields.bucket;
        const path = formData.fields.path;
        console.log(`Received upload request for Bucket: [${bucket}], Path: [${path}]`);

        const s3Client = createS3Client(config);
        
        const filesToUpload = formData.files || [];
        console.log(`Found ${filesToUpload.length} file(s) to upload.`);

        const uploadPromises = filesToUpload.map(async (file) => {
            let fileData: Uint8Array | undefined;
            let source: string = 'unknown';

            if (file.content) {
                fileData = file.content;
                source = 'memory';
            } else if (file.filename) {
                console.log(`Reading file "${file.originalName}" from temporary location: ${file.filename}`);
                fileData = await Deno.readFile(file.filename);
                source = `disk (${file.filename})`;
            }

            if (!fileData || fileData.length === 0) {
                console.log(`Skipping file "${file.originalName}" due to empty content from source: ${source}.`);
                return;
            }

            const key = `${path}${file.originalName}`;
            
            console.log(`Preparing to upload with @aws-sdk/lib-storage:`);
            console.log(`  -> File: ${file.originalName}`);
            console.log(`  -> Size: ${fileData.length} bytes`);
            console.log(`  -> S3 Key: ${key}`);

            try {
                // Use the Upload utility from lib-storage for robust uploads.
                const parallelUploads3 = new Upload({
                    client: s3Client,
                    params: {
                        Bucket: bucket,
                        Key: key,
                        Body: fileData,
                        ContentType: file.contentType,
                        // FIX: Disable checksum calculation which is causing errors in this environment.
                        ChecksumMode: "DISABLED"
                    },
                });
                
                // .done() returns a promise that resolves on successful upload.
                await parallelUploads3.done();
                console.log(`✅ Successfully uploaded ${key}`);

            } catch (uploadError) {
                console.error(`❌ Failed to upload ${key}:`, uploadError);
                // Propagate a more informative error message to the client.
                throw new Error(`Failed to upload ${file.originalName}: ${uploadError.message || 'Unknown S3 error'}`);
            }
        });
        
        await Promise.all(uploadPromises);
        
        console.log("--- Upload Request Finished ---\n");
        ctx.response.body = { success: true, message: 'All files processed.' };

    } catch (error) {
        console.error("Upload process failed:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: error.message };
    }
});


// Route to delete buckets or objects.
router.post("/delete", async (ctx) => {
    try {
        const body = await ctx.request.body({ type: 'json' }).value;
        const { config, bucket, items } = body;
        const s3Client = createS3Client(config);
        
        const objectsToDelete = items.filter((item: any) => !item.isBucket);
        const bucketsToDelete = items.filter((item: any) => item.isBucket);

        // Delete objects if any
        if (objectsToDelete.length > 0) {
            if (!bucket) throw new Error("Bucket name is required for deleting objects.");
            const deleteParams = {
                Bucket: bucket,
                Delete: { Objects: objectsToDelete.map((item: any) => ({ Key: item.Key })) },
            };
            await s3Client.send(new DeleteObjectsCommand(deleteParams));
        }

        // Delete buckets if any
        for (const b of bucketsToDelete) {
            await s3Client.send(new DeleteBucketCommand({ Bucket: b.Name }));
        }

        ctx.response.body = { success: true, message: 'Items deleted successfully.' };
    } catch (error) {
        console.error("Delete failed:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: error.message };
    }
});

// --- Middleware and Server Start ---

// Use CORS middleware to allow requests from the frontend origin.
app.use(oakCors({ origin: "*" })); // This applies to all routes including API

// API routes
app.use(router.routes());
app.use(router.allowedMethods());

// Static file serving middleware
app.use(async (ctx) => {
  // Try to send the static file. `send` will handle the response.
  await send(ctx, ctx.request.url.pathname, {
    root: `${Deno.cwd()}/static`, // Assumes index.html is in a 'static' subfolder
    index: "index.html",
  });
});


console.log("Deno S3 backend is running on http://localhost:8000");
await app.listen({ port: 8000 });
