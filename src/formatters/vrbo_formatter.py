"""
Output formatter for VRBO property details.

Transforms raw PropertyContent and PropertySummary API responses into the target output schema.
"""

from datetime import datetime, timezone
from typing import Optional, Any
import re


def safe_get(data: dict, *keys, default=None):
    """Safely navigate nested dict structure."""
    result = data
    for key in keys:
        if isinstance(result, dict):
            result = result.get(key)
        elif isinstance(result, list) and isinstance(key, int) and len(result) > key:
            result = result[key]
        else:
            return default
        if result is None:
            return default
    return result


def extract_text_items(items: list) -> list[str]:
    """Extract text values from PropertyContent items array."""
    texts = []
    for item in items or []:
        typename = item.get("__typename", "")

        if typename == "PropertyContentItemMarkup":
            text = safe_get(item, "content", "text")
            if text:
                # Strip HTML tags
                clean_text = re.sub(r'<[^>]+>', ' ', text).strip()
                clean_text = re.sub(r'\s+', ' ', clean_text)
                texts.append(clean_text)

        elif typename == "PropertyContentItemText":
            value = safe_get(item, "content", "primary", "value")
            if value:
                texts.append(value)

        elif typename == "PropertyContentItemTexts":
            for content in item.get("contents", []):
                value = safe_get(content, "primary", "value")
                if value:
                    texts.append(value)

    return texts


def extract_rating_from_page_layout(page_layout_data: Optional[dict]) -> tuple[Optional[float], Optional[int], Optional[str]]:
    """
    Extract rating and review count from TemplatePageLayout config.

    Primary source: seoStructuredData with aggregateRating:
    {
        "@type": "AggregateRating",
        "bestRating": "10",
        "ratingValue": "9.0",
        "reviewCount": "28"
    }

    Fallback: "See all X reviews" pattern in config for review count.

    Returns:
        Tuple of (rating_value, review_count, rating_text)
    """
    import json as json_module

    if not page_layout_data:
        return None, None, None

    config_str = safe_get(page_layout_data, "data", "pageLayout", "config")
    if not config_str or not isinstance(config_str, str):
        return None, None, None

    rating_value = None
    review_count = None
    rating_text = None

    try:
        config = json_module.loads(config_str)
    except (json_module.JSONDecodeError, TypeError):
        config = None

    # Search recursively for seoStructuredData containing aggregateRating
    def find_aggregate_rating(obj):
        if isinstance(obj, dict):
            if "seoStructuredData" in obj:
                seo_str = obj["seoStructuredData"]
                if isinstance(seo_str, str):
                    try:
                        seo_data = json_module.loads(seo_str)
                        if "aggregateRating" in seo_data:
                            return seo_data["aggregateRating"]
                    except (json_module.JSONDecodeError, TypeError):
                        pass
            for v in obj.values():
                result = find_aggregate_rating(v)
                if result:
                    return result
        elif isinstance(obj, list):
            for item in obj:
                result = find_aggregate_rating(item)
                if result:
                    return result
        return None

    aggregate_rating = find_aggregate_rating(config) if config else None

    if aggregate_rating:
        # Extract from aggregateRating (primary source)
        rating_str = aggregate_rating.get("ratingValue")
        if rating_str and rating_str != "null":
            try:
                rating_value = float(rating_str)
            except (ValueError, TypeError):
                pass

        count_str = aggregate_rating.get("reviewCount")
        if count_str and count_str != "null":
            try:
                review_count = int(count_str)
            except (ValueError, TypeError):
                pass

        # Build rating text like "9.0 out of 10"
        best_rating = aggregate_rating.get("bestRating", "10")
        if rating_value is not None:
            rating_text = f"{rating_value} out of {best_rating}"

    # Fallback: extract review count from "See all X reviews" pattern
    if review_count is None and config_str:
        see_all_pattern = re.compile(r'[Ss]ee all (\d+) reviews?')
        match = see_all_pattern.search(config_str)
        if match:
            try:
                review_count = int(match.group(1))
            except (ValueError, TypeError):
                pass

    return rating_value, review_count, rating_text


def extract_rating(review_summary: dict, review_data: Optional[dict] = None) -> tuple[Optional[float], Optional[str]]:
    """Extract numeric rating and its text representation from review summary responses."""
    # Pattern to extract rating from text like "4.8 out of 5" or "18.0/10"
    # Captures: rating value, max value (e.g., "18.0/10" -> 18.0, 10)
    rating_with_max_pattern = re.compile(r"(\d+(?:\.\d+)?)\s*(?:out of|/)\s*(\d+)")
    number_pattern = re.compile(r"(\d+(?:\.\d+)?)")

    candidates = [
        safe_get(review_summary, "overallScoreWithDescriptionA11y", "value"),
        safe_get(review_summary, "overallScoreWithDescriptionA11y", "accessibilityLabel"),
        safe_get(review_summary, "overallScoreWithDescriptionA11y", "score"),
        safe_get(review_summary, "overallScore", "value"),
        safe_get(review_summary, "overallScore", "formatted"),
        safe_get(review_summary, "overallScore", "score"),
    ]

    rating_text = next((c for c in candidates if isinstance(c, str) and c.strip()), None)
    rating_value = None

    # Try explicit candidates first
    for val in candidates:
        if isinstance(val, (int, float)) and 0 <= val <= 10:
            rating_value = float(val)
            break
        if isinstance(val, str):
            # Try "X out of Y" or "X/Y" pattern - normalize to 10-point scale
            match = rating_with_max_pattern.search(val)
            if match:
                parsed = float(match.group(1))
                max_val = float(match.group(2))
                # Normalize to 10-point scale
                # Expedia uses doubled scale (9.0 displayed as 18.0/10)
                if max_val == 10 and parsed > 10:
                    # Expedia doubled rating: 18.0/10 means 9.0
                    rating_value = round(parsed / 2, 1)
                elif max_val == 5:
                    # Convert 5-point scale to 10-point
                    rating_value = round(parsed * 2, 1)
                elif max_val == 10:
                    rating_value = parsed
                else:
                    # Normalize any other scale to 10-point
                    rating_value = round((parsed / max_val) * 10, 1)
                break
            # Then try simple number, but only if it's a valid rating (0-10)
            match = number_pattern.search(val)
            if match:
                parsed = float(match.group(1))
                if 0 <= parsed <= 10:
                    rating_value = parsed
                    break

    if rating_value is not None and not rating_text:
        rating_text = str(rating_value)

    return rating_value, rating_text


def extract_description(content_data: dict) -> str:
    """Extract description from PropertyContent aboutThisProperty section."""
    about = safe_get(content_data, "data", "propertyInfo", "propertyContentSectionGroups", "aboutThisProperty", default={})
    sections = about.get("sections", [])

    description_parts = []
    title = None

    for section in sections:
        body_subs = section.get("bodySubSections", [])
        for sub in body_subs:
            elements_v2 = sub.get("elementsV2", [])
            for elem_group in elements_v2:
                for element in elem_group.get("elements", []):
                    # Get title from header
                    header = element.get("header", {})
                    if header:
                        header_text = header.get("text")
                        if header_text and not title:
                            title = header_text

                    # Get description from items
                    items = element.get("items", [])
                    texts = extract_text_items(items)
                    description_parts.extend(texts)

    return " ".join(description_parts).strip()


def extract_amenities_summary(content_data: dict) -> list[dict]:
    """Extract highlighted amenities from amenitiesSummary."""
    amenities_list = []

    amenities = safe_get(content_data, "data", "propertyInfo", "amenitiesSummary", "amenities", default={})
    sections = amenities.get("sections", [])

    for section in sections:
        body_subs = section.get("bodySubSections", [])
        for sub in body_subs:
            elements_v2 = sub.get("elementsV2", [])
            for elem_group in elements_v2:
                for element in elem_group.get("elements", []):
                    items = element.get("items", [])
                    for item in items:
                        if item.get("__typename") == "PropertyContentItemText":
                            value = safe_get(item, "content", "primary", "value")
                            icon_id = safe_get(item, "content", "primary", "icon", "id")
                            if value:
                                amenities_list.append({
                                    "iconId": icon_id,
                                    "text": value
                                })

    return amenities_list


def extract_detailed_amenities(content_data: dict) -> list[dict]:
    """Extract detailed amenities organized by category."""
    categories = []

    # Try detailedAmenitiesContent first (VRBO structure)
    detailed = safe_get(content_data, "data", "propertyInfo", "detailedAmenitiesContent", "amenities", default={})
    sections = detailed.get("sections", [])

    if sections:
        # VRBO structure: categories are in bodySubSections headers
        for section in sections:
            body_subs = section.get("bodySubSections", [])
            for sub in body_subs:
                category_name = safe_get(sub, "header", "text")
                if not category_name:
                    continue

                items = []
                elements_v2 = sub.get("elementsV2", [])
                for elem_group in elements_v2:
                    for element in elem_group.get("elements", []):
                        texts = extract_text_items(element.get("items", []))
                        items.extend(texts)

                if items:
                    categories.append({
                        "title": category_name,
                        "items": items
                    })
    else:
        # Fallback to amenitiesSummary (Expedia/Hotels.com structure)
        # Categories are in element headers, not bodySubSection headers
        summary = safe_get(content_data, "data", "propertyInfo", "amenitiesSummary", "amenities", default={})
        sections = summary.get("sections", [])

        for section in sections:
            body_subs = section.get("bodySubSections", [])
            for sub in body_subs:
                elements_v2 = sub.get("elementsV2", [])
                for elem_group in elements_v2:
                    for element in elem_group.get("elements", []):
                        # Get category name from element header
                        category_name = safe_get(element, "header", "text")
                        if not category_name:
                            continue

                        items = extract_text_items(element.get("items", []))
                        if items:
                            categories.append({
                                "title": category_name,
                                "items": items
                            })

    return categories


def extract_policies(content_data: dict) -> list[dict]:
    """Extract policies from PropertyContent."""
    policies_list = []

    policies = safe_get(content_data, "data", "propertyInfo", "propertyContentSectionGroups", "policies", default={})
    sections = policies.get("sections", [])

    for section in sections:
        section_header = section.get("header", {})
        section_title = section_header.get("text")

        items = []
        body_subs = section.get("bodySubSections", [])

        for sub in body_subs:
            elements_v2 = sub.get("elementsV2", [])
            for elem_group in elements_v2:
                for element in elem_group.get("elements", []):
                    # Get subsection header
                    header = element.get("header", {})
                    sub_title = header.get("text") if header else None
                    icon_id = safe_get(header, "icon", "id") if header else None

                    # Get items
                    texts = extract_text_items(element.get("items", []))

                    if sub_title and texts:
                        items.append({
                            "iconId": icon_id,
                            "title": sub_title,
                            "items": texts
                        })
                    elif texts:
                        items.extend(texts)

        if items:
            policies_list.append({
                "title": section_title,
                "items": items
            })

    return policies_list


def extract_important_info(content_data: dict) -> list[str]:
    """Extract important information items."""
    info_items = []

    important = safe_get(content_data, "data", "propertyInfo", "propertyContentSectionGroups", "importantInfo", default={})
    sections = important.get("sections", [])

    for section in sections:
        body_subs = section.get("bodySubSections", [])
        for sub in body_subs:
            elements_v2 = sub.get("elementsV2", [])
            for elem_group in elements_v2:
                for element in elem_group.get("elements", []):
                    texts = extract_text_items(element.get("items", []))
                    info_items.extend(texts)

    return info_items


def extract_host_data(content_data: dict) -> dict:
    """Extract host information from aboutThisHost section."""
    result = {
        "id": None,
        "name": None,
        "profileImage": None,
        "about": None
    }

    about_host = safe_get(content_data, "data", "propertyInfo", "propertyContentSectionGroups", "aboutThisHost", default={})
    sections = about_host.get("sections", [])

    for section in sections:
        # Check section header for host name
        section_header = section.get("header", {})
        if section_header:
            header_text = section_header.get("text")
            if header_text and not result["name"]:
                # Header text often contains "Hosted by {name}" or just the name
                match = re.search(r"(?:[Hh]osted by\s+)?(.+)", header_text)
                if match:
                    result["name"] = match.group(1).strip()

        body_subs = section.get("bodySubSections", [])
        for sub in body_subs:
            elements_v2 = sub.get("elementsV2", [])
            for elem_group in elements_v2:
                for element in elem_group.get("elements", []):
                    # Check for profile image in leadingGraphic
                    leading_graphic = element.get("leadingGraphic", {})
                    if leading_graphic and isinstance(leading_graphic, dict):
                        image = leading_graphic.get("image", {})
                        if image and isinstance(image, dict):
                            img_url = image.get("url")
                            if img_url and not result["profileImage"]:
                                result["profileImage"] = img_url

                    # Check header for host name
                    header = element.get("header", {})
                    if header:
                        header_text = header.get("text")
                        if header_text and not result["name"]:
                            result["name"] = header_text

                    # Extract about text from items
                    items = element.get("items", [])
                    texts = extract_text_items(items)
                    if texts and not result["about"]:
                        result["about"] = " ".join(texts)

    return result


def extract_review_count(review_data: Optional[dict], summary_data: dict) -> Optional[int]:
    """Extract total review count from PropertySummary."""
    count_pattern = re.compile(r"(\d+)\s*(?:review|rating)", re.IGNORECASE)

    # Try PropertySummary reviewSummary (the only reliable source)
    review_summary = safe_get(summary_data, "data", "propertyInfo", "propertyDetails", "reviewSummary", default={})
    if review_summary:
        # Check totalCount (nested structure with raw/formatted)
        total_count = review_summary.get("totalCount")
        if isinstance(total_count, dict):
            val = total_count.get("raw")
            if isinstance(val, (int, float)) and val > 0:
                return int(val)
            formatted = total_count.get("formatted")
            if isinstance(formatted, str):
                try:
                    val = int(formatted.replace(",", ""))
                    if val > 0:
                        return val
                except ValueError:
                    pass
            val = total_count.get("value")
            if isinstance(val, int) and val > 0:
                return val

        # Also check direct fields
        for key in ["totalCount", "count", "reviewCount"]:
            val = review_summary.get(key)
            if isinstance(val, int) and val > 0:
                return val

        # Check accessibilityLabel for review count like "4.8 out of 5, 28 reviews"
        score_obj = review_summary.get("overallScoreWithDescriptionA11y", {})
        accessibility_label = score_obj.get("accessibilityLabel") if isinstance(score_obj, dict) else None
        if accessibility_label:
            match = count_pattern.search(accessibility_label)
            if match:
                return int(match.group(1))

    return None


def extract_room_setup(features: list) -> dict:
    """Parse room setup numbers from feature text."""
    result = {
        "guestCount": None,
        "bedroomCount": None,
        "bathroomCount": None
    }

    sleeps_pattern = re.compile(r"[Ss]leeps?\s*(\d+)")
    bedroom_pattern = re.compile(r"(\d+)\s*bedroom", re.IGNORECASE)
    bathroom_pattern = re.compile(r"(\d+)\s*bathroom", re.IGNORECASE)

    for feature in features or []:
        text = feature.get("text", "") if isinstance(feature, dict) else str(feature)

        if result["guestCount"] is None:
            match = sleeps_pattern.search(text)
            if match:
                result["guestCount"] = int(match.group(1))

        if result["bedroomCount"] is None:
            match = bedroom_pattern.search(text)
            if match:
                result["bedroomCount"] = int(match.group(1))

        if result["bathroomCount"] is None:
            match = bathroom_pattern.search(text)
            if match:
                result["bathroomCount"] = int(match.group(1))

    return result


def extract_house_rules(policies: list) -> dict:
    """Extract structured house rules from policies."""
    result = {
        "checkInTime": None,
        "checkOutTime": None,
        "smokingAllowed": None,
        "petsAllowed": None,
        "eventsAllowed": None
    }

    # Patterns for check-in/check-out times
    checkin_pattern = re.compile(r"[Cc]heck[- ]?in[:\s]+(?:after\s+)?(\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?)", re.IGNORECASE)
    checkout_pattern = re.compile(r"[Cc]heck[- ]?out[:\s]+(?:before\s+)?(\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?)", re.IGNORECASE)

    # Patterns for boolean rules
    smoking_no_pattern = re.compile(r"no\s+smoking|smoking\s+(?:is\s+)?not\s+(?:allowed|permitted)|non[- ]?smoking", re.IGNORECASE)
    smoking_yes_pattern = re.compile(r"smoking\s+(?:is\s+)?(?:allowed|permitted)", re.IGNORECASE)

    pets_no_pattern = re.compile(r"no\s+pets|pets?\s+(?:are\s+)?not\s+allowed|pet[- ]?free", re.IGNORECASE)
    pets_yes_pattern = re.compile(r"pets?\s+(?:are\s+)?allowed|pets?\s+welcome|pet[- ]?friendly", re.IGNORECASE)

    events_no_pattern = re.compile(r"no\s+(?:events?|parties)|(?:events?|parties)\s+(?:are\s+)?not\s+allowed", re.IGNORECASE)
    events_yes_pattern = re.compile(r"(?:events?|parties)\s+(?:are\s+)?allowed|suitable\s+for\s+events", re.IGNORECASE)

    def _search_policies(obj):
        """Recursively search through policy structure for text."""
        texts = []
        if isinstance(obj, dict):
            for key, val in obj.items():
                if key in ("text", "title", "value") and isinstance(val, str):
                    texts.append(val)
                else:
                    texts.extend(_search_policies(val))
        elif isinstance(obj, list):
            for item in obj:
                texts.extend(_search_policies(item))
        elif isinstance(obj, str):
            texts.append(obj)
        return texts

    all_text = " ".join(_search_policies(policies))

    # Extract check-in time
    match = checkin_pattern.search(all_text)
    if match:
        result["checkInTime"] = match.group(1).strip()

    # Extract check-out time
    match = checkout_pattern.search(all_text)
    if match:
        result["checkOutTime"] = match.group(1).strip()

    # Extract smoking policy
    if smoking_no_pattern.search(all_text):
        result["smokingAllowed"] = False
    elif smoking_yes_pattern.search(all_text):
        result["smokingAllowed"] = True

    # Extract pets policy
    if pets_no_pattern.search(all_text):
        result["petsAllowed"] = False
    elif pets_yes_pattern.search(all_text):
        result["petsAllowed"] = True

    # Extract events policy
    if events_no_pattern.search(all_text):
        result["eventsAllowed"] = False
    elif events_yes_pattern.search(all_text):
        result["eventsAllowed"] = True

    return result


def extract_images(gallery_data: dict) -> list[dict]:
    """Extract images from ProductGallery response."""
    images = []

    gallery = safe_get(gallery_data, "data", "productGallery", default={})

    # Featured images first
    featured = gallery.get("featured", [])
    for img_info in featured or []:
        if not isinstance(img_info, dict):
            continue
        image = safe_get(img_info, "image", default={})
        url = image.get("url") if isinstance(image, dict) else None
        description = (image.get("description") if isinstance(image, dict) else None) or img_info.get("description")
        if url:
            images.append({
                "url": url,
                "description": description
            })

    # Categorized images
    categorized = gallery.get("categorizedImages", [])
    for category in categorized or []:
        if not isinstance(category, dict):
            continue
        category_images = category.get("images", [])
        for img_info in category_images or []:
            if not isinstance(img_info, dict):
                continue
            image = safe_get(img_info, "image", default={})
            url = image.get("url") if isinstance(image, dict) else None
            description = (image.get("description") if isinstance(image, dict) else None) or img_info.get("description")
            if url and not any(i.get("url") == url for i in images):
                images.append({
                    "url": url,
                    "description": description
                })

    return images


def extract_features(summary_data: dict) -> list[dict]:
    """Extract property features (bedrooms, bathrooms, sleeps) from PropertySummary spaceOverview."""
    features = []

    space_overview = safe_get(summary_data, "data", "propertyInfo", "summary", "spaceOverview", default={})

    def extract_from_item(item: dict) -> dict:
        """Extract feature info from a PropertyInfoItem."""
        if not isinstance(item, dict):
            return None

        text = item.get("text")
        primary = item.get("primary", {}) or {}
        primary_text = primary.get("text") if isinstance(primary, dict) else None

        icon_id = None
        primary_graphic = safe_get(primary, "graphic", default={})
        if isinstance(primary_graphic, dict):
            icon_id = primary_graphic.get("id")
        if not icon_id:
            item_graphic = item.get("graphic", {})
            if isinstance(item_graphic, dict):
                icon_id = item_graphic.get("id")
        if not icon_id:
            item_icon = item.get("icon", {})
            if isinstance(item_icon, dict):
                icon_id = item_icon.get("id")

        display_text = primary_text or text
        if display_text:
            return {"iconId": icon_id, "text": display_text}
        return None

    # Check infoItems first
    info_items = space_overview.get("infoItems", [])
    for item in info_items or []:
        feature = extract_from_item(item)
        if feature:
            features.append(feature)

    # Also check items array
    items = space_overview.get("items", [])
    for item in items or []:
        feature = extract_from_item(item)
        if feature and not any(f.get("text") == feature.get("text") for f in features):
            features.append(feature)

    return features


def extract_pricing(offers_data: dict) -> dict:
    """Extract pricing information from PropertyOffers response."""
    trip_summary = safe_get(offers_data, "data", "propertyOffers", "tripSummary", default={})

    if not trip_summary:
        return None

    price = trip_summary.get("price", {})
    if not price:
        return None

    lead = price.get("lead", {})
    total = price.get("total", {})

    currency_info = lead.get("currencyInfo", {})

    result = {
        "total": total.get("amount"),
        "nightly": lead.get("amount"),
        "currency": currency_info.get("code"),
        "formattedTotal": lead.get("formatted"),
        "roomNightMessage": price.get("roomNightMessage")
    }

    # Get display messages
    display_messages = price.get("displayMessages", [])
    price_lines = []
    for msg in display_messages or []:
        line_items = msg.get("lineItems", [])
        for item in line_items:
            if item.get("__typename") == "DisplayPrice":
                formatted = safe_get(item, "price", "formatted")
                label = safe_get(item, "price", "accessibilityLabel")
                if formatted:
                    price_lines.append({"formatted": formatted, "label": label})
    if price_lines:
        result["priceBreakdown"] = price_lines

    return result


def extract_unit_price(listing: dict) -> Optional[dict]:
    """
    Extract per-unit pricing from LodgingCategorizedUnit.

    Schema path discovered via GraphQL probing:
    primarySelections[].propertyUnit.ratePlans[].priceDetails.price.{lead,total}

    Note: priceDetails can be either a dict (VRBO) or a list (Expedia).
    When it's a list, we iterate through it to find the price object.

    Args:
        listing: A LodgingCategorizedUnit object from categorizedListings

    Returns:
        Price dict with amount, formatted, total, and currency, or None if not available
    """
    primary_selections = listing.get("primarySelections", []) or []

    for selection in primary_selections:
        if not isinstance(selection, dict):
            continue

        property_unit = selection.get("propertyUnit", {}) or {}
        rate_plans = property_unit.get("ratePlans", []) or []

        for rate_plan in rate_plans:
            if not isinstance(rate_plan, dict):
                continue

            price_details_raw = rate_plan.get("priceDetails")

            # Handle priceDetails being either a dict (VRBO) or list (Expedia)
            if isinstance(price_details_raw, list):
                # Expedia format: priceDetails is a list of price detail objects
                for pd in price_details_raw:
                    if not isinstance(pd, dict):
                        continue
                    price = pd.get("price", {}) or {}
                    result = _extract_price_from_object(price)
                    if result:
                        return result
            elif isinstance(price_details_raw, dict):
                # VRBO format: priceDetails is a single dict
                price = price_details_raw.get("price", {}) or {}
                result = _extract_price_from_object(price)
                if result:
                    return result

    return None


def _extract_price_from_object(price: dict) -> Optional[dict]:
    """Helper to extract price data from a price object."""
    if not isinstance(price, dict):
        return None

    lead = price.get("lead", {}) or {}
    total = price.get("total", {}) or {}

    # Check if we have actual price data
    if lead.get("amount") is not None or lead.get("formatted"):
        currency_info = lead.get("currencyInfo", {}) or {}
        return {
            "amount": lead.get("amount"),
            "formatted": lead.get("formatted"),
            "total": total.get("amount"),
            "totalFormatted": total.get("formatted"),
            "currency": currency_info.get("code")
        }

    return None


def extract_units_from_offers(
    offers_data: dict,
    gallery_data: Optional[dict] = None
) -> list[dict]:
    """
    Extract unit information from PropertyOffers categorizedListings.

    Multi-unit properties (apartments, condos with multiple rooms) return
    LodgingCategorizedUnit objects with detailed unit information:
    - unitId: Unit identifier
    - header.text: Unit name (e.g., "Studio", "Deluxe Studio")
    - header.subText: Unit description (if available)
    - features[].text: Unit features (e.g., "248 sq ft • Sleeps 2 • 1 Queen Bed")

    Per-unit pricing is extracted from:
    primarySelections[].propertyUnit.ratePlans[].priceDetails.price.{lead,total}

    Note on images:
    - Unit-specific images: The API's propertyUnit.gallery field exists but typically
      returns empty. As a fallback, we use property-level images from ProductGallery
      "Bedrooms" category, distributed across units.

    Args:
        offers_data: Raw PropertyOffers API response
        gallery_data: Raw ProductGallery API response (optional) for fallback images

    Returns:
        List of unit dicts with id, name, features, images, and price
    """
    units = []

    categorized_listings = safe_get(
        offers_data, "data", "propertyOffers", "categorizedListings", default=[]
    )

    # Extract property-level price from tripSummary as fallback (for units without per-unit pricing)
    trip_summary = safe_get(offers_data, "data", "propertyOffers", "tripSummary", default={})
    property_price = None
    if trip_summary:
        price_data = trip_summary.get("price", {}) or {}
        lead = price_data.get("lead", {}) or {}
        if lead.get("formatted") or lead.get("amount"):
            currency_info = lead.get("currencyInfo", {}) or {}
            total_data = price_data.get("total", {}) or {}
            property_price = {
                "amount": lead.get("amount"),
                "formatted": lead.get("formatted"),
                "total": total_data.get("amount"),
                "totalFormatted": None,
                "currency": currency_info.get("code")
            }

    # Extract fallback images from ProductGallery "Bedrooms" category
    bedroom_images = []
    if gallery_data:
        categorized_images = safe_get(
            gallery_data, "data", "productGallery", "categorizedImages", default=[]
        )
        for category in categorized_images or []:
            # Look for Bedrooms/rooms category
            cat_id = category.get("categoryId", "")
            cat_name = category.get("categoryName", "")
            if "rooms" in cat_id.lower() or "bedroom" in cat_name.lower():
                images_list = category.get("images", []) or []
                for img_item in images_list:
                    img = img_item.get("image", {}) or {}
                    if img.get("url"):
                        bedroom_images.append({
                            "url": img.get("url"),
                            "description": img.get("description"),
                            "aspectRatio": img.get("aspectRatio")
                        })
                break

    num_units = sum(
        1 for listing in (categorized_listings or [])
        if isinstance(listing, dict) and listing.get("__typename") == "LodgingCategorizedUnit"
    )

    unit_index = 0
    for listing in categorized_listings or []:
        if not isinstance(listing, dict):
            continue

        # Check if this is a LodgingCategorizedUnit (multi-unit property)
        typename = listing.get("__typename")
        if typename == "LodgingCategorizedUnit":
            unit_id = listing.get("unitId")
            if unit_id:
                # Extract unit name from header
                header = listing.get("header", {}) or {}
                unit_name = header.get("text")
                unit_subtext = header.get("subText")

                # Extract features array
                features_data = listing.get("features", []) or []
                features = []
                for feature in features_data:
                    if isinstance(feature, dict) and feature.get("text"):
                        features.append(feature["text"])

                # Extract per-unit price from primarySelections, fallback to property price
                unit_price = extract_unit_price(listing) or property_price

                # Distribute bedroom images across units as fallback
                # Each unit gets a slice of the available images
                unit_images = []
                if bedroom_images and num_units > 0:
                    images_per_unit = max(1, len(bedroom_images) // num_units)
                    start_idx = unit_index * images_per_unit
                    end_idx = start_idx + images_per_unit
                    unit_images = bedroom_images[start_idx:end_idx]

                units.append({
                    "id": unit_id,
                    "name": unit_name,
                    "description": unit_subtext,
                    "features": features,
                    "images": unit_images,
                    "price": unit_price
                })

                unit_index += 1

    return units


def format_property(
    summary_data: dict,
    content_data: dict,
    url: str,
    property_id: str,
    gallery_data: Optional[dict] = None,
    offers_data: Optional[dict] = None,
    review_data: Optional[dict] = None,
    page_layout_data: Optional[dict] = None
) -> dict:
    """
    Transform API responses to target output schema.

    Args:
        summary_data: Raw PropertySummary API response
        content_data: Raw PropertyContent API response
        url: Original property URL
        property_id: Property ID
        gallery_data: Raw ProductGallery API response (optional)
        offers_data: Raw PropertyOffers API response (optional)
        review_data: Raw ProductReviewSummary API response (optional)
        page_layout_data: Raw TemplatePageLayout API response (optional)

    Returns:
        Formatted property dict matching target schema
    """
    # Extract from PropertySummary
    summary = safe_get(summary_data, "data", "propertyInfo", "summary", default={})

    name = summary.get("name", "")
    tagline = summary.get("tagline", "")

    # Location data
    location = summary.get("location", {})
    address = location.get("address", {})
    coordinates = location.get("coordinates", {})
    parent_region = location.get("parentRegion", {})

    # Review/rating - try page layout first (most reliable), then fall back to review summary
    rating, review_count_from_layout, rating_text = extract_rating_from_page_layout(page_layout_data)

    # Fall back to PropertySummary reviewSummary if page layout didn't have rating
    if rating is None:
        property_details = safe_get(summary_data, "data", "propertyInfo", "propertyDetails", default={})
        review_summary = property_details.get("reviewSummary", {})
        rating, rating_text = extract_rating(review_summary, review_data)

    # Extract from PropertyContent
    description = extract_description(content_data)
    highlighted_amenities = extract_amenities_summary(content_data)
    detailed_amenities = extract_detailed_amenities(content_data)
    policies = extract_policies(content_data)
    important_info = extract_important_info(content_data)

    # Extract images from gallery data
    images = extract_images(gallery_data) if gallery_data else []

    # Extract features from summary data
    features = extract_features(summary_data)

    # Extract pricing from offers data
    pricing = extract_pricing(offers_data) if offers_data else None

    # Extract host data
    host = extract_host_data(content_data)

    # Extract review count - prefer page layout, fall back to review data
    review_count = review_count_from_layout
    if review_count is None:
        review_count = extract_review_count(review_data, summary_data)

    # Extract room setup (parse counts from features)
    room_setup = extract_room_setup(features)

    # Extract structured house rules from policies
    house_rules = extract_house_rules(policies)

    # Get thumbnail (first image URL)
    thumbnail = images[0].get("url") if images else None

    # Extract units from categorizedListings (multi-unit properties)
    units = extract_units_from_offers(offers_data, gallery_data) if offers_data else []

    # If no units found from categorizedListings, create single-unit fallback
    # This handles single-unit properties that don't have categorizedListings
    if not units and pricing:
        units.append({
            "id": None,
            "name": None,
            "images": [],
            "features": features,
            "price": pricing
        })

    # Detect source from URL
    source = "VRBO"
    if "expedia.com" in url:
        source = "Expedia"
    elif "hotels.com" in url:
        source = "Hotels.com"

    return {
        "source": source,
        "url": url,
        "id": property_id,
        "name": name or tagline,
        "tagline": tagline if tagline != name else None,
        "description": description[:1000] if description else None,
        "thumbnail": thumbnail,
        "latitude": coordinates.get("latitude"),
        "longitude": coordinates.get("longitude"),
        "country": address.get("countryCode"),
        "city": address.get("city"),
        "region": address.get("province") or parent_region.get("name"),
        "street": address.get("addressLine"),
        "rating": rating,
        "ratingText": rating_text,
        "reviewCount": review_count,
        "guestCount": room_setup.get("guestCount"),
        "bedroomCount": room_setup.get("bedroomCount"),
        "bathroomCount": room_setup.get("bathroomCount"),
        "images": images,
        "features": features,
        "highlightedAmenities": highlighted_amenities,
        "amenities": detailed_amenities,
        "policies": policies,
        "importantInfo": important_info,
        "host": host,
        "houseRules": house_rules,
        "units": units,
        "scrapedAt": datetime.now(timezone.utc).isoformat()
    }


def format_error(url: str, property_id: str, error: str, source: str = "VRBO") -> dict:
    """Format error response for a failed property fetch."""
    return {
        "source": source,
        "url": url,
        "id": property_id,
        "error": error,
        "scrapedAt": datetime.now(timezone.utc).isoformat()
    }
