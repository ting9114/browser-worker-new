#!/bin/bash
# Start a virtual display so Playwright can run with headless=false
# This bypasses Yahoo's headless browser detection — same as running locally
Xvfb :99 -screen 0 1920x1080x24 -ac &
export DISPLAY=:99

# Wait for Xvfb to be ready
sleep 1

echo "Virtual display :99 started"
exec node src/server.js
