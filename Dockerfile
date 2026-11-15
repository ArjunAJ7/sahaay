FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY public ./public
EXPOSE 8080
ENV TZ=Asia/Calcutta
CMD ["node", "src/server.js"]
