ARG BUILDKIT_VERSION=v0.17.3
# buildctl: the client the worker uses to talk to the sandboxed BuildKit daemon (a static binary).
FROM moby/buildkit:${BUILDKIT_VERSION} AS buildkit

FROM node:20-alpine
COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl
RUN apk add --no-cache git docker-cli openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/server.js"]
