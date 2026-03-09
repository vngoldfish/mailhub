FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies accurately
RUN npm install --production

# Copy application source
COPY . .

# Expose the API port
EXPOSE 8899

# Run the application
CMD ["node", "index.js"]
