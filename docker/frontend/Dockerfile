FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
ARG VITE_FEATURES_API_URL=http://127.0.0.1:3006/api/v1/features
ENV VITE_FEATURES_API_URL=${VITE_FEATURES_API_URL}
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3005 \
    HOST=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/dist/standalone ./
# Vinext does not yet copy its React peer dependencies into
# standalone output, so keep the required production peers explicit.
COPY --from=build --chown=node:node /app/node_modules/react ./node_modules/react
COPY --from=build --chown=node:node /app/node_modules/react-dom ./node_modules/react-dom
COPY --from=build --chown=node:node /app/node_modules/react-server-dom-webpack ./node_modules/react-server-dom-webpack
COPY --from=build --chown=node:node /app/node_modules/scheduler ./node_modules/scheduler

USER node
EXPOSE 3005

CMD ["node", "server.js"]
