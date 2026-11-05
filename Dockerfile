# Vanta engine + dashboard. Contract artifacts are built on the host (`forge build`)
# and copied in, so the image needs no Solidity toolchain.
FROM node:24-slim
WORKDIR /app
COPY engine/package.json engine/package-lock.json engine/
RUN cd engine && npm ci --omit=dev --no-audit --no-fund
COPY engine/src engine/src
COPY dashboard dashboard
COPY deployments deployments
COPY contracts/out contracts/out
# Solidity SDK served to the in-browser compiler (/sdk/*)
COPY contracts/src contracts/src
ENV NETWORK=testnet \
    PORT=8080 \
    NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "engine/src/engine.ts"]
