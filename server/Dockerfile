FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
EXPOSE 4000
ENV PORT=4000
CMD ["node", "dist/index.js"]
