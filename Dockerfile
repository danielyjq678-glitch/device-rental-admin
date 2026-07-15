FROM node:18-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --production && apk del python3 make g++
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]