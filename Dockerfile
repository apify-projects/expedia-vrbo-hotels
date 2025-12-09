# Use official Apify Python image
FROM apify/actor-python:3.11

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt ./

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Set the entry point
CMD ["python", "src/main.py"]
