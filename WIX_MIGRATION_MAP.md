# Starwood Events & Entertainment — Wix & Velo Architecture & Migration Map

This document establishes the official bridge between the design source of truth (the Starwood Events & Entertainment editorial pitch deck / standalone implementation) and the native Wix + Velo implementation.

---

## 1. System Architecture Overview

```
starwood-events/
├── wix.config.json                  (Site ID: 46b29f03-58c7-45cd-8b1f-2c24fdc4dcfb)
├── wix.lock                         (Wix CLI local state & type runtime)
├── package.json                     (Wix CLI & ESLint configuration)
├── src/
│   ├── pages/
│   │   ├── masterPage.js            (Global navigation, sticky header, mobile menu, footer)
│   │   └── HOME.tuckg.js            (Home page: 9 chapters, repeaters, forms, interactions)
│   ├── backend/
│   │   ├── contactService.jsw       (Secure server-side lead/inquiry submission web module)
│   │   └── permissions.json         (Web method invocation permissions)
│   └── public/
│       ├── data/
│       │   └── siteData.js          (Structured data model from Starwood pitch deck)
│       ├── images/                  (All 19 high-resolution event & founder assets)
│       ├── editorial-styles.css     (Master editorial typography & design system tokens)
│       └── favicon.svg              (Starwood 'S' royal filigree crest)
```

---

## 2. Element & Chapter Migration Mapping

| HTML Section ID | Wix Section ID | Wix Element Type | Velo ID | Velo & Interactive Responsibility |
|---|---|---|---|---|
| `#top` (Header) | `#header1` | `Header` / `Box` | `#mainHeader` | Sticky blur elevation, scroll progress calculation, brand crest |
| Navigation Links | `#navList` | `Menu` / `Button[]` | `#navHero`, `#navStage`, etc. | Smooth anchor scrolling to chapter targets, mobile collapse |
| Mobile Toggle | `#navToggle` | `Button` / `Icon` | `#navToggleBtn` | Shows/hides `#mobileNavDrawer` with fade transition |
| **01 #entrance** | `#entranceSection` | `Section` | `#entranceSection` | Hero viewport container, circular mask composition |
| Hero Headline | `#entrance-title` | `Heading (H1)` | `#heroTitle` | Injected with `"STARWOOD EVENTS"` in Cormorant Garamond |
| Hero Tagline | `.hero-tagline` | `Text` | `#heroTagline` | `"YOUR VISION, OUR EXECUTION"` |
| Hero Quote | `.hero-quote` | `Text` | `#heroQuote` | Italicized quote: *“We don’t just organise celebrations...”* |
| Primary CTA | `.btn-pill-arrow` | `Button` | `#heroPrimaryCta` | Smooth scrolls to `#visionSection` |
| Secondary CTA | `.btn-ghost` | `Button` | `#heroSecondaryCta` | Smooth scrolls to `#gallerySection` |
| Proof Metrics | `.proof-row` | `Repeater` | `#heroProofRepeater` | Renders Established (2012), Curated (200+), Clients (50+) |
| **02 #vision** | `#visionSection` | `Section` | `#visionSection` | Stage presence, seamless event success spread |
| Vision CTA | `.btn-primary` | `Button` | `#visionConsultBtn` | Smooth scrolls to `#contactSection` |
| Vision Visual | `.mask-card` | `Image` | `#visionMainImage` | Renders `venue-ballroom.jpg` |
| **03 #about** | `#aboutSection` | `Section` | `#aboutSection` | Take your seat: Founders & Partnership |
| Founders Grid | `.founders-grid` | `Repeater` | `#foundersRepeater` | Dynamic card list for Sameer Khan & Nimit Shah with arch crop |
| Proof Strip | `.about-proof-strip` | `Repeater` | `#aboutProofRepeater` | Experience, Volume, Retention, and High Referral Rate |
| Philosophy Box | `.mantra-box` | `Repeater` | `#philosophyRepeater` | 5-step Starwood service tenets |
| **04 #events** | `#eventsSection` | `Section` | `#eventsSection` | Celebrations grid (Corporate, Weddings, Social, Property) |
| Event Tiles | `.celebrations-grid` | `Repeater` | `#celebrationsRepeater` | Binds titles, descriptions, feature badges, and direct contact inquiry link |
| **05 #management** | `#managementSection`| `Section` | `#managementSection`| Flatlay visual, quote card, and 4 discipline pillars |
| **06 #services** | `#servicesSection` | `Section` | `#servicesSection` | 6 production capabilities (Anchors, Itinerary, Photo, Artists, F&B, Décor) |
| Service Table | `.services-list` | `Repeater` | `#servicesRepeater` | Interactive rows with hover feedback and navigation to contact |
| **07 #gallery** | `#gallerySection` | `Section` | `#gallerySection` | Vertical title display + 6-frame mosaic |
| Gallery Frames | `.gallery-mosaic-grid`| `Repeater` / `Gallery`| `#galleryRepeater` | Dynamic image binding with hover captions |
| **08 #stories** | `#storiesSection` | `Section` | `#storiesSection` | Selected work cards (Birthday, Wedding, Corporate Summit) |
| Story Cards | `.stories-cards-grid`| `Repeater` | `#storiesRepeater` | Scope meta tags and narrative details |
| **09 #contact** | `#contactSection` | `Section` | `#contactSection` | Final station: availability calendar & inquiry form |
| Form Inputs | `.enquiry-form` | `TextInput`, `DatePicker`, `Dropdown` | `#inquiryNameInput`, `#inquiryPhoneInput`, etc. | Validated user event parameters |
| Submit Button | `.btn-gold` | `Button` | `#inquirySubmitBtn` | Calls `submitEventInquiry()` web module via `backend/contactService.jsw` |
| Submission Status | `.status-message` | `Text` | `#inquiryStatusText` | Inline confirmation without page reload |
| **Footer** | `#footer1` | `Footer` | `#footer1` | Persistent copyright, phone links, and studio address |

---

## 3. Wix Editor Manual Steps Before Publishing

1. **Open the Local Editor**: Run `npm run dev` to launch the Local Editor.
2. **Review Elements & IDs**: Verify that sections and containers in the Wix Studio canvas have their corresponding IDs (`#entranceSection`, `#visionSection`, `#aboutSection`, etc.) assigned in the Velo Properties & Events panel.
3. **Repeater Connections**: For sections utilizing repeaters (`#celebrationsRepeater`, `#servicesRepeater`, `#foundersRepeater`), ensure the child elements inside the repeater template match the IDs mapped above (`#founderName`, `#celebrationTitle`, etc.).
4. **Publish**: In Wix Studio / Editor, click **Publish** to deploy live to the production domain.
