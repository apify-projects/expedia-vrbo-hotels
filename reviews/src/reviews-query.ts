// The PropertyFilteredReviewsQuery operation, verbatim from the Expedia Android
// app client. It is kept complete on purpose: the selection set is what produces
// the raw review shape this Actor outputs, so trimming a field is a breaking
// change to the dataset.

export const REVIEWS_QUERY = `
query PropertyFilteredReviewsQuery(
    $context: ContextInput!
    $propertyId: String!
    $searchCriteria: PropertySearchCriteriaInput!
) {
    propertyReviewSummaries(
        context: $context
        propertyIds: [$propertyId]
        searchCriteria: $searchCriteria
    ) {
        ...__PropertyReviewSummaryFragment
        __typename
    }
    propertyInfo(context: $context, propertyId: $propertyId) {
        id
        reviewInfo(searchCriteria: $searchCriteria) {
            ...__PropertyReviewsListFragment
            sortAndFilter {
                ...TravelerTypeFragment
                ...SortTypeFragment
                ...SearchTextFragment
                ...PopularMentionsFragment
                __typename
            }
            __typename
        }
        __typename
    }
}

fragment __PropertyReviewSummaryFragment on PropertyReviewSummary {
    accessibilityLabel
    overallScoreWithDescriptionA11y {
        ...LodgingEnrichedMessageFragment
        __typename
    }
    propertyReviewCountDetails {
        fullDescription
        __typename
    }
    ...ReviewDisclaimerFragment
    reviewSummaryDetails {
        label
        ratingPercentage
        formattedRatingOutOfMax
        __typename
    }
    totalCount {
        raw
        __typename
    }
    __typename
}

fragment ReviewDisclaimerFragment on PropertyReviewSummary {
    reviewDisclaimer
    reviewDisclaimerHeading
    strategy
    reviewDisclaimerValues {
        text
        __typename
    }
    reviewDisclaimerLabel
    reviewDisclaimerAnalytics {
        referrerId
        linkName
        __typename
    }
    reviewDisclaimerUrl {
        value
        accessibilityLabel
        link {
            url
            __typename
        }
        __typename
    }
    reviewDisclaimerAccessibilityLabel
    __typename
}

fragment LodgingEnrichedMessageFragment on LodgingEnrichedMessage {
    __typename
    subText
    subtexts
    value
    theme
    state
    accessibilityLabel
    icon {
        id
        size
        theme
        __typename
    }
    mark {
        id
        __typename
    }
    egdsMark {
        url {
            value
            __typename
        }
        __typename
    }
}

fragment __PropertyReviewsListFragment on PropertyReviews {
    summary {
        paginateAction {
            text
            analytics {
                referrerId
                linkName
                __typename
            }
            __typename
        }
        __typename
    }
    reviews {
        contentDirectFeedbackPromptId
        ...ReviewParentFragment
        managementResponses {
            ...ReviewChildFragment
            __typename
        }
        reviewInteractionSections {
            primaryDisplayString
            reviewInteractionType
            __typename
        }
        __typename
    }
    impressionAnalytics
    ...NoResultsMessageFragment
    __typename
}

fragment ReviewParentFragment on PropertyReview {
    id
    superlative
    locale
    title
    brandType
    disclaimer
    reviewScoreWithDescription {
        label
        value
        __typename
    }
    text
    highlightedText {
        ...EGDSSpannableTextFragment
        __typename
    }
    seeMoreAnalytics {
        linkName
        referrerId
        __typename
    }
    submissionTime {
        longDateFormat
        __typename
    }
    impressionAnalytics {
        event
        referrerId
        __typename
    }
    themes {
        ...ReviewThemeFragment
        __typename
    }
    reviewFooter {
        ...PropertyReviewFooterSectionFragment
        __typename
    }
    reviewAnalytics
    ...FeedbackIndicatorFragment
    ...AuthorFragment
    ...PhotosFragment
    ...TravelersFragment
    ...ReviewTranslationInfoFragment
    ...PropertyReviewSourceFragment
    ...PropertyReviewRegionFragment
    __typename
}

fragment AuthorFragment on PropertyReview {
    reviewAuthorAttribution {
        text
        __typename
    }
    __typename
}

fragment PhotosFragment on PropertyReview {
    id
    photoSection {
        imageClickAnalytics {
            referrerId
            linkName
            __typename
        }
        exitAnalytics {
            referrerId
            linkName
            __typename
        }
        navClickAnalytics {
            referrerId
            linkName
            __typename
        }
        intersectionAnalytics {
            referrerId
            linkName
            __typename
        }
        __typename
    }
    photos {
        description
        url
        __typename
    }
    __typename
}

fragment TravelersFragment on PropertyReview {
    travelers
    __typename
}

fragment ReviewThemeFragment on ReviewThemes {
    icon {
        id
        __typename
    }
    label
    __typename
}

fragment FeedbackIndicatorFragment on PropertyReview {
    reviewInteractionSections {
        primaryDisplayString
        accessibilityLabel
        reviewInteractionType
        feedbackAnalytics {
            linkName
            referrerId
            __typename
        }
        __typename
    }
    __typename
}

fragment ReviewTranslationInfoFragment on PropertyReview {
    translationInfo {
        loadingTranslationText
        targetLocale
        translatedBy {
            description
            __typename
        }
        translationCallToActionLabel
        seeOriginalText
        __typename
    }
    __typename
}

fragment PropertyReviewSourceFragment on PropertyReview {
    propertyReviewSource {
        accessibilityLabel
        graphic {
            description
            id
            size
            token
            url {
                value
                __typename
            }
            __typename
        }
        text {
            value
            __typename
        }
        __typename
    }
    __typename
}

fragment PropertyReviewRegionFragment on PropertyReview {
    reviewRegion {
        id
        __typename
    }
    __typename
}

fragment PropertyReviewFooterSectionFragment on PropertyReviewFooterSection {
    messages {
        seoStructuredData {
            itemscope
            itemprop
            itemtype
            content
            __typename
        }
        text {
            ... on EGDSPlainText {
                text
                __typename
            }
            ... on EGDSGraphicText {
                text
                graphic {
                    ... on Mark {
                        description
                        id
                        size
                        url {
                            ... on HttpURI {
                                relativePath
                                value
                                __typename
                            }
                            __typename
                        }
                        __typename
                    }
                    __typename
                }
                __typename
            }
            __typename
        }
        __typename
    }
    __typename
}

fragment EGDSSpannableTextFragment on EGDSSpannableText {
    text
    contents {
        ...EGDSSpannableTextContentFragment
        __typename
    }
    inlineContent {
        ...EGDSSpannableTextContentFragment
        __typename
    }
    egdsElementId
    __typename
}

fragment EGDSSpannableTextContentFragment on EGDSText {
    ...EGDSStylizedTextFragment
    ...EGDSPlainTextFragment
    ...LodgingEGDSGraphicTextFragment
    ...EGDSInlineLinkFragment
    __typename
}

fragment EGDSStylizedTextFragment on EGDSStylizedText {
    __typename
    text
    theme
    weight
    size
    decorative
    accessibility
}

fragment EGDSPlainTextFragment on EGDSPlainText {
    text
    __typename
}

fragment EGDSInlineLinkFragment on EGDSInlineLink {
    action {
        accessibility
        analytics {
            linkName
            referrerId
            __typename
        }
        resource {
            value
            __typename
        }
        target
        __typename
    }
    disabled
    sizeEGDSLink: size
    text
    __typename
}

fragment LodgingEGDSGraphicTextFragment on EGDSGraphicText {
    accessibility
    text
    graphic {
        ... on Icon {
            id
            size
            __typename
        }
        ... on Mark {
            url {
                ... on HttpURI {
                    value
                    __typename
                }
                __typename
            }
            __typename
        }
        __typename
    }
    __typename
}

fragment ReviewChildFragment on ManagementResponse {
    id
    header {
        text
        __typename
    }
    response
    __typename
}

fragment NoResultsMessageFragment on PropertyReviews {
    noResultsMessage {
        __typename
        ...MessagingCardFragment
        ...EmptyStateFragment
    }
    __typename
}

fragment MessagingCardFragment on UIMessagingCard {
    graphic {
        __typename
        ... on Icon {
            id
            description
            __typename
        }
    }
    primary
    secondaries
    __typename
}

fragment EmptyStateFragment on UIEmptyState {
    heading
    body
    __typename
}

fragment TravelerTypeFragment on SortAndFilterViewModel {
    sortAndFilter {
        name
        label
        clickAnalytics {
            linkName
            referrerId
            __typename
        }
        options {
            label
            isSelected
            optionValue
            description
            clickAnalytics {
                linkName
                referrerId
                __typename
            }
            __typename
        }
        __typename
    }
    __typename
}

fragment SortTypeFragment on SortAndFilterViewModel {
    sortAndFilter {
        name
        label
        clickAnalytics {
            linkName
            referrerId
            __typename
        }
        options {
            label
            isSelected
            optionValue
            description
            clickAnalytics {
                linkName
                referrerId
                __typename
            }
            __typename
        }
        __typename
    }
    __typename
}

fragment SearchTextFragment on SortAndFilterViewModel {
    sortAndFilter {
        name
        label
        graphic {
            ...SearchTextIconFragment
            __typename
        }
        submittedAnalytics
        initiatedAnalytics
        __typename
    }
    __typename
}

fragment SearchTextIconFragment on Icon {
    description
    id
    token
    __typename
}

fragment PopularMentionsFragment on SortAndFilterViewModel {
    sortAndFilter {
        title
        placeholder
        label
        name
        showListOptions {
            seeLessLabel
            seeMoreLabel
            __typename
        }
        options {
            ariaLabel
            clickAnalytics {
                referrerId
                linkName
                __typename
            }
            optionValue
            label
            isSelected
            __typename
        }
        clickAnalytics {
            referrerId
            linkName
            __typename
        }
        __typename
    }
    __typename
}
`;
