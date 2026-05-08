FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

RUN apt-get update && apt-get install -y xvfb

COPY package.json ./

RUN npm install && \
    npx playwright install chromium --with-deps && \
    rm -rf /var/lib/apt/lists/*

COPY src/ ./src/
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

EXPOSE 3001

USER node

CMD ["./entrypoint.sh"]