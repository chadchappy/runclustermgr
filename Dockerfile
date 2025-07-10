# Production stage with nginx
FROM nginx:alpine

# Install envsubst (part of gettext package)
RUN apk add --no-cache gettext

# Copy nginx configuration template
COPY nginx.conf.template /etc/nginx/nginx.conf.template

# Copy pre-built application
COPY build /usr/share/nginx/html

# Create startup script
COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

# Create a directory for nginx to write temporary files
RUN mkdir -p /var/cache/nginx && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /usr/share/nginx/html

# Expose port 3000
EXPOSE 3000

# Use custom entrypoint
ENTRYPOINT ["/startup.sh"]
CMD ["nginx", "-g", "daemon off;"]
