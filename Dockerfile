FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api/package.json packages/api/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace @carepoint/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api/package.json packages/api/package.json
RUN npm ci --omit=dev
COPY --from=build /app/packages/api/dist packages/api/dist
EXPOSE 4000
CMD ["npm", "start"]
