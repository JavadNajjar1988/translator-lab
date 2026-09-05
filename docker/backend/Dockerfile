FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node server ./server
COPY docker/backend/entrypoint.sh /usr/local/bin/translator-lab-entrypoint
RUN chmod 755 /usr/local/bin/translator-lab-entrypoint

EXPOSE 3006

ENTRYPOINT ["translator-lab-entrypoint"]
