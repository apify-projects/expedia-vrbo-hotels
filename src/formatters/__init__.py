# Output formatters - shared across VRBO, Expedia, and Hotels.com
# All three platforms use the same GraphQL schema and response structure
from .vrbo_formatter import format_property, format_error

__all__ = [
    "format_property",
    "format_error",
]
