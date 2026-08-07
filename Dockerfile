FROM node:20-slim
WORKDIR /app
COPY . .
RUN cd server && npm install --no-audit --no-fund
RUN cd client && npm install --no-audit --no-fund && npm run build
RUN cd server && node seed.js && node seed-hashibasha.js
ENV PORT=4000
EXPOSE 4000
WORKDIR /app/server
CMD ["node", "index.js"]
