FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install minimal system deps commonly needed by Python wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Trust corporate CA for pip/requests inside Docker
COPY cert.pem /usr/local/share/ca-certificates/corp-ca.crt
RUN update-ca-certificates
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt

# Install Python dependencies from pyproject.toml
COPY pyproject.toml ./
RUN python -c "import tomllib, pathlib, subprocess, sys; deps=tomllib.loads(pathlib.Path('pyproject.toml').read_text(encoding='utf-8'))['project']['dependencies']; subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--upgrade', 'pip']); subprocess.check_call([sys.executable, '-m', 'pip', 'install', *deps])"

# Copy application code and assets
COPY . .

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
