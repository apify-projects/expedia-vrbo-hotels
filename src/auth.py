"""
HMAC Signing utilities for Expedia Group API authentication.

Works for VRBO, Expedia, and Hotels.com - all use the same credentials.
Based on reverse-engineered HMACInterceptor from Expedia Android apps.
"""

import hmac
import hashlib
import base64
import random
import string
from datetime import datetime, timezone


# Credentials from Expedia app (strings.xml) - shared across all platforms
HMAC_USERNAME = "fe627e29-3afb-4384-9fc0-a1d2a4dcd30c"
HMAC_SECRET_KEY = "S1q3f5rhAe3SCE4N"  # Deobfuscated from XOR ^ 28 + reverse


def generate_salt(length: int = 16) -> str:
    """Generate a random alphanumeric salt."""
    chars = string.ascii_letters + string.digits
    return ''.join(random.choice(chars) for _ in range(length))


def get_rfc1123_date() -> str:
    """Get current date in RFC 1123 format (GMT timezone)."""
    now = datetime.now(timezone.utc)
    # Format: "Fri, 29 Nov 2024 12:34:56 GMT"
    return now.strftime("%a, %d %b %Y %H:%M:%S GMT")


def build_signing_data(method: str, path: str, query: str | None, date: str, salt: str) -> str:
    """
    Build the data string to be signed.

    Format:
        {METHOD} {PATH}[?{QUERY}] HTTP/1.1
        x-date: {DATE}
        salt: {SALT}
    """
    request_line = f"{method} {path}"
    if query:
        request_line += f"?{query}"
    request_line += " HTTP/1.1"

    return f"{request_line}\nx-date: {date}\nsalt: {salt}"


def create_hmac_signature(secret_key: str, data: str) -> str:
    """Create HMAC-SHA256 signature and return as base64."""
    signature = hmac.new(
        secret_key.encode('utf-8'),
        data.encode('utf-8'),
        hashlib.sha256
    ).digest()
    return base64.b64encode(signature).decode('utf-8')


def build_authorization_header(
    method: str,
    path: str,
    query: str | None,
    date: str,
    salt: str,
    username: str = HMAC_USERNAME,
    secret_key: str = HMAC_SECRET_KEY
) -> str:
    """
    Build the full Authorization header value.

    Format:
        hmac username="{username}",algorithm="hmac-sha256",headers="request-line x-date salt",signature="{signature}"
    """
    data = build_signing_data(method, path, query, date, salt)
    signature = create_hmac_signature(secret_key, data)

    return (
        f'hmac username="{username}",'
        f'algorithm="hmac-sha256",'
        f'headers="request-line x-date salt",'
        f'signature="{signature}"'
    )


def get_signed_headers(method: str, path: str, query: str | None = None) -> dict:
    """
    Get all headers needed for a signed request.

    Returns dict with:
        - authorization
        - x-date
        - salt
    """
    date = get_rfc1123_date()
    salt = generate_salt(16)

    authorization = build_authorization_header(method, path, query, date, salt)

    return {
        "authorization": authorization,
        "x-date": date,
        "salt": salt
    }


if __name__ == "__main__":
    # Test the signing
    headers = get_signed_headers("POST", "/graphql", None)
    print("Generated headers:")
    for key, value in headers.items():
        print(f"  {key}: {value}")
