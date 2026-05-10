#!/bin/sh

echo "🚀 Starting Horizon Backend..."

# Start server in background
echo "📡 Starting server..."
node dist/server.js &
SERVER_PID=$!

# Start document worker in background
echo "⚙️  Starting document worker..."
node dist/worker.js &
WORKER_PID=$!

# Start image worker in background
echo "🖼️  Starting image worker..."
node dist/imageWorker.js &
IMG_WORKER_PID=$!

echo "✅ All processes started (Server: $SERVER_PID, Worker: $WORKER_PID, ImageWorker: $IMG_WORKER_PID)"

# Wait for any process to exit
wait -n

# Exit with status of process that exited first
exit $?
