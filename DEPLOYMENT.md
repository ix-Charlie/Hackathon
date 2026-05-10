<!-- TEMPORARY FILE -->
Deploy this Streamlit app to Google Cloud Run without me doing anything manually.

The app is a Streamlit project with this structure:
coding-bootcamp-builder/
├── src/
│   ├── agents/
│   ├── main.py
│   └── app.py
├── .env
├── requirements.txt

Do the following in order and confirm each step before moving to the next:

1. Create a Dockerfile in the project root that:
   - Uses python:3.11-slim as the base image
   - Sets /app as the working directory
   - Copies requirements.txt and installs all dependencies
   - Copies the full project into the image
   - Exposes port 8080
   - Runs the app with:
     streamlit run src/app.py --server.port=8080 --server.address=0.0.0.0

2. Create a .dockerignore in the project root that excludes:
   .env, __pycache__, *.pyc, .DS_Store, tmp/

3. Check if gcloud CLI is installed by running:
   gcloud --version
   If it is not installed, give me the exact install command for my OS 
   and wait for me to confirm it is installed before continuing.

4. Check if I am logged into gcloud by running:
   gcloud auth list
   If I am not logged in, run:
   gcloud auth login
   and wait for me to confirm login before continuing.

5. Ask me for my Google Cloud project ID and store it for all 
   subsequent commands. Do not proceed until I provide it.

6. Enable the required Google Cloud APIs by running:
   gcloud services enable run.googleapis.com containerregistry.googleapis.com cloudbuild.googleapis.com
   Wait for confirmation before continuing.

7. Build and push the Docker image by running:
   gcloud builds submit --tag gcr.io/MY_PROJECT_ID/coding-bootcamp-builder
   Replace MY_PROJECT_ID with the project ID I provided.
   Wait for this to complete successfully before continuing.

8. Deploy to Cloud Run by running:
   gcloud run deploy coding-bootcamp-builder \
     --image gcr.io/MY_PROJECT_ID/coding-bootcamp-builder \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --port 8080
   Replace MY_PROJECT_ID with the project ID I provided.

9. After deployment succeeds, tell me the live URL that Cloud Run returns.

10. Remind me to go to Cloud Run in the Google Cloud Console, 
    open the service, click Edit and Deploy New Revision, 
    go to Variables and Secrets, and add these environment variables 
    manually so they are never stored in the image:
    - OPENAI_API_KEY
    - Any other keys from the .env file

If any step fails, stop immediately, show me the full error message, 
explain what went wrong in plain English, and tell me exactly what 
to do to fix it before retrying.
