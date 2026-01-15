FROM node:20-alpine

WORKDIR /app

# Copiamos manifests para aprovechar cache
COPY package.json package-lock.json ./

# Instalación determinista
RUN npm ci

# Copiamos el resto del proyecto
COPY . .

# Carpeta para uploads (después se monta como volumen)
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]