FROM node:20-bullseye-slim
WORKDIR /app/apps/api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/api/package*.json ./
RUN npm ci
COPY apps/api/prisma ./prisma
RUN npx prisma generate
COPY apps/api/docker-entrypoint.sh /app/apps/api/docker-entrypoint.sh
RUN chmod +x /app/apps/api/docker-entrypoint.sh
COPY apps/api/src ./src
COPY apps/api/tests ./tests
COPY apps/api/tsconfig.json ./tsconfig.json
COPY packages/shared /app/packages/shared
EXPOSE 4000
ENTRYPOINT ["/app/apps/api/docker-entrypoint.sh"]
CMD ["npm","run","dev"]
