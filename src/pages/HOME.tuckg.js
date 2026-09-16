// Starwood Events & Entertainment — Home Page Controller (Velo)
// Page ID: tuckg (HOME)
// Controls: Section Initialization, Repeater Bindings, Smooth Navigation,
// Lead Inquiries via Backend Web Module, Interactive Accordion & Cards
import {
  BRAND,
  PROOF_METRICS,
  FOUNDERS,
  PHILOSOPHY,
  CELEBRATIONS,
  SERVICES,
  STORIES,
  GALLERY_FRAMES
} from 'public/data/siteData';
import { submitEventInquiry } from 'backend/contactService';

$w.onReady(function () {
  initHeroChapter();
  initVisionChapter();
  initAboutChapter();
  initCelebrationsChapter();
  initManagementChapter();
  initServicesChapter();
  initGalleryChapter();
  initStoriesChapter();
  initContactChapter();
});

/**
 * 01 — GRAND ENTRANCE (HERO)
 */
function initHeroChapter() {
  if ($w('#heroTitle').length > 0) {
    $w('#heroTitle').text = BRAND.shortName.toUpperCase();
  }
  if ($w('#heroTagline').length > 0) {
    $w('#heroTagline').text = BRAND.tagline.toUpperCase();
  }
  if ($w('#heroQuote').length > 0) {
    $w('#heroQuote').text = `“${BRAND.quote}”`;
  }

  // CTA button scroll handlers
  if ($w('#heroPrimaryCta').length > 0) {
    $w('#heroPrimaryCta').onClick(() => {
      if ($w('#visionSection').length > 0) {
        $w('#visionSection').scrollTo();
      }
    });
  }

  if ($w('#heroSecondaryCta').length > 0) {
    $w('#heroSecondaryCta').onClick(() => {
      if ($w('#gallerySection').length > 0) {
        $w('#gallerySection').scrollTo();
      }
    });
  }

  // Hero Proof Metrics Binding
  if ($w('#heroProofRepeater').length > 0) {
    const repeaterItems = PROOF_METRICS.slice(0, 3).map((item, idx) => ({
      _id: `metric-${idx}`,
      label: item.label,
      value: item.value
    }));
    $w('#heroProofRepeater').data = repeaterItems;
    $w('#heroProofRepeater').onItemReady(($item, itemData) => {
      if ($item('#metricLabel').length > 0) $item('#metricLabel').text = itemData.label;
      if ($item('#metricValue').length > 0) $item('#metricValue').text = itemData.value;
    });
  }
}

/**
 * 02 — STAGE PRESENCE (YOUR VISION, OUR EXECUTION)
 */
function initVisionChapter() {
  if ($w('#visionConsultBtn').length > 0) {
    $w('#visionConsultBtn').onClick(() => {
      if ($w('#contactSection').length > 0) {
        $w('#contactSection').scrollTo();
      }
    });
  }
}

/**
 * 03 — TAKE YOUR SEAT (ABOUT & FOUNDERS)
 */
function initAboutChapter() {
  // Founders Repeater
  if ($w('#foundersRepeater').length > 0) {
    const foundersData = FOUNDERS.map((f, i) => ({
      _id: `founder-${i}`,
      name: f.name,
      role: f.role,
      image: f.image
    }));
    $w('#foundersRepeater').data = foundersData;
    $w('#foundersRepeater').onItemReady(($item, itemData) => {
      if ($item('#founderName').length > 0) $item('#founderName').text = itemData.name;
      if ($item('#founderRole').length > 0) $item('#founderRole').text = itemData.role;
    });
  }

  // Proof Strip Repeater
  if ($w('#aboutProofRepeater').length > 0) {
    const proofData = PROOF_METRICS.map((p, i) => ({
      _id: `about-proof-${i}`,
      label: p.label,
      value: p.value,
      detail: p.detail
    }));
    $w('#aboutProofRepeater').data = proofData;
    $w('#aboutProofRepeater').onItemReady(($item, itemData) => {
      if ($item('#proofCellLabel').length > 0) $item('#proofCellLabel').text = itemData.label;
      if ($item('#proofCellValue').length > 0) $item('#proofCellValue').text = itemData.value;
      if ($item('#proofCellDetail').length > 0) $item('#proofCellDetail').text = itemData.detail;
    });
  }

  // Philosophy Steps
  if ($w('#philosophyRepeater').length > 0) {
    const philoData = PHILOSOPHY.map((item, i) => ({
      _id: `philo-${i}`,
      step: item.step,
      text: item.text
    }));
    $w('#philosophyRepeater').data = philoData;
    $w('#philosophyRepeater').onItemReady(($item, itemData) => {
      if ($item('#philoStep').length > 0) $item('#philoStep').text = itemData.step;
      if ($item('#philoText').length > 0) $item('#philoText').text = itemData.text;
    });
  }
}

/**
 * 04 — THE CELEBRATIONS (EVENTS WE DELIVER)
 */
function initCelebrationsChapter() {
  if ($w('#celebrationsRepeater').length > 0) {
    const eventItems = CELEBRATIONS.map((evt) => ({
      _id: evt.id,
      category: evt.category,
      title: evt.title,
      description: evt.description,
      features: evt.features.join('  •  ')
    }));

    $w('#celebrationsRepeater').data = eventItems;
    $w('#celebrationsRepeater').onItemReady(($item, itemData) => {
      if ($item('#celebrationBadge').length > 0) $item('#celebrationBadge').text = itemData.category;
      if ($item('#celebrationTitle').length > 0) $item('#celebrationTitle').text = itemData.title;
      if ($item('#celebrationDesc').length > 0) $item('#celebrationDesc').text = itemData.description;
      if ($item('#celebrationFeatures').length > 0) $item('#celebrationFeatures').text = itemData.features;
      if ($item('#celebrationLinkBtn').length > 0) {
        $item('#celebrationLinkBtn').onClick(() => {
          if ($w('#contactSection').length > 0) {
            $w('#contactSection').scrollTo();
            // Pre-select category in contact form if input exists
            if ($w('#inquiryTypeInput').length > 0) {
              $w('#inquiryTypeInput').value = itemData.title;
            }
          }
        });
      }
    });
  }
}

/**
 * 05 — THE ART OF EVENT MANAGEMENT (PRODUCTION SPREAD)
 */
function initManagementChapter() {
  // Static narrative spread
}

/**
 * 06 — SERVICES WE PROVIDE
 */
function initServicesChapter() {
  if ($w('#servicesRepeater').length > 0) {
    const serviceData = SERVICES.map((s, i) => ({
      _id: `service-${i}`,
      num: s.num,
      title: s.title,
      description: s.description
    }));

    $w('#servicesRepeater').data = serviceData;
    $w('#servicesRepeater').onItemReady(($item, itemData) => {
      if ($item('#serviceNum').length > 0) $item('#serviceNum').text = itemData.num;
      if ($item('#serviceTitle').length > 0) $item('#serviceTitle').text = itemData.title;
      if ($item('#serviceDesc').length > 0) $item('#serviceDesc').text = itemData.description;
      if ($item('#serviceItemBtn').length > 0) {
        $item('#serviceItemBtn').onClick(() => {
          if ($w('#contactSection').length > 0) {
            $w('#contactSection').scrollTo();
          }
        });
      }
    });
  }
}

/**
 * 07 — THE GALLERY
 */
function initGalleryChapter() {
  if ($w('#galleryRepeater').length > 0) {
    const frames = GALLERY_FRAMES.map((g, i) => ({
      _id: `frame-${i}`,
      title: g.title
    }));
    $w('#galleryRepeater').data = frames;
    $w('#galleryRepeater').onItemReady(($item, itemData) => {
      if ($item('#galleryFrameTitle').length > 0) $item('#galleryFrameTitle').text = itemData.title;
    });
  }
}

/**
 * 08 — STARWOOD STORIES
 */
function initStoriesChapter() {
  if ($w('#storiesRepeater').length > 0) {
    const storiesData = STORIES.map((st, i) => ({
      _id: `story-${i}`,
      category: st.category,
      title: st.title,
      description: st.description,
      scope: st.scope
    }));

    $w('#storiesRepeater').data = storiesData;
    $w('#storiesRepeater').onItemReady(($item, itemData) => {
      if ($item('#storyCategory').length > 0) $item('#storyCategory').text = itemData.category;
      if ($item('#storyTitle').length > 0) $item('#storyTitle').text = itemData.title;
      if ($item('#storyDesc').length > 0) $item('#storyDesc').text = itemData.description;
      if ($item('#storyScope').length > 0) $item('#storyScope').text = `Scope: ${itemData.scope}`;
    });
  }
}

/**
 * 09 — LET'S GET IN TOUCH (CONTACT & INQUIRY)
 */
function initContactChapter() {
  if ($w('#inquirySubmitBtn').length > 0) {
    $w('#inquirySubmitBtn').onClick(async () => {
      const nameInput = $w('#inquiryNameInput');
      const phoneInput = $w('#inquiryPhoneInput');
      const emailInput = $w('#inquiryEmailInput');
      const dateInput = $w('#inquiryDateInput');
      const typeInput = $w('#inquiryTypeInput');
      const msgInput = $w('#inquiryMsgInput');
      const statusText = $w('#inquiryStatusText');

      // Validation
      if (!nameInput || !nameInput.value || nameInput.value.trim().length < 2) {
        if (statusText && statusText.length > 0) {
          statusText.text = 'Please enter your full name.';
          statusText.show();
        }
        return;
      }

      if (!phoneInput || !phoneInput.value || phoneInput.value.trim().length < 8) {
        if (statusText && statusText.length > 0) {
          statusText.text = 'Please provide a valid phone or WhatsApp number.';
          statusText.show();
        }
        return;
      }

      // Disable button and show pending state
      $w('#inquirySubmitBtn').disable();
      if (statusText && statusText.length > 0) {
        statusText.text = 'Sending inquiry to Starwood production team...';
        statusText.show();
      }

      try {
        const payload = {
          name: nameInput.value,
          phone: phoneInput.value,
          email: emailInput && emailInput.value ? emailInput.value : null,
          eventDate: dateInput && dateInput.value ? dateInput.value : null,
          eventType: typeInput && typeInput.value ? typeInput.value : 'General Inquiry',
          message: msgInput && msgInput.value ? msgInput.value : null
        };

        const response = await submitEventInquiry(payload);

        if (response.success) {
          if (statusText && statusText.length > 0) {
            statusText.text = response.message;
          }
          // Reset fields
          nameInput.value = '';
          phoneInput.value = '';
          if (emailInput) emailInput.value = '';
          if (msgInput) msgInput.value = '';
        } else {
          if (statusText && statusText.length > 0) {
            statusText.text = response.error || 'Failed to submit inquiry. Please call +91 98679 32747.';
          }
          $w('#inquirySubmitBtn').enable();
        }
      } catch (err) {
        console.error('[Starwood Velo Error]', err);
        if (statusText && statusText.length > 0) {
          statusText.text = 'Network error. Please call +91 98679 32747 directly.';
        }
        $w('#inquirySubmitBtn').enable();
      }
    });
  }
}
