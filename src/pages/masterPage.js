// Starwood Events & Entertainment — Master Page Global Controller (Velo)
// Handles: Global Navigation, Scroll Progress, Brand Crest, Header Elevation, Global Footer
import { BRAND } from 'public/data/siteData';

$w.onReady(function () {
  initGlobalHeader();
  initFooter();
});

/**
 * Initializes persistent global header, navigation links, and mobile drawer
 */
function initGlobalHeader() {
  const currentYear = new Date().getFullYear();

  // Bind footer year if element exists on master page
  if ($w('#footerYear').length > 0) {
    $w('#footerYear').text = String(currentYear);
  }

  // Mobile menu drawer toggle
  if ($w('#navToggleBtn').length > 0 && $w('#mobileNavDrawer').length > 0) {
    $w('#navToggleBtn').onClick(() => {
      const drawer = $w('#mobileNavDrawer');
      if (drawer.isVisible) {
        drawer.hide('fade', { duration: 250 });
      } else {
        drawer.show('fade', { duration: 250 });
      }
    });
  }

  // Anchor links on navigation menu
  const navMap = [
    { buttonId: '#navHero', target: '#entranceSection' },
    { buttonId: '#navStage', target: '#visionSection' },
    { buttonId: '#navAbout', target: '#aboutSection' },
    { buttonId: '#navEvents', target: '#eventsSection' },
    { buttonId: '#navProduction', target: '#managementSection' },
    { buttonId: '#navServices', target: '#servicesSection' },
    { buttonId: '#navGallery', target: '#gallerySection' },
    { buttonId: '#navStories', target: '#storiesSection' },
    { buttonId: '#navContact', target: '#contactSection' },
    { buttonId: '#headerCtaBtn', target: '#contactSection' }
  ];

  navMap.forEach(({ buttonId, target }) => {
    if ($w(buttonId).length > 0) {
      $w(buttonId).onClick(() => {
        if ($w(target).length > 0) {
          $w(target).scrollTo();
        }
        if ($w('#mobileNavDrawer').length > 0 && $w('#mobileNavDrawer').isVisible) {
          $w('#mobileNavDrawer').hide('fade', { duration: 200 });
        }
      });
    }
  });
}

/**
 * Initializes footer contact points and social links
 */
function initFooter() {
  if ($w('#footerBrandName').length > 0) {
    $w('#footerBrandName').text = BRAND.name;
  }
  if ($w('#footerAddressText').length > 0) {
    $w('#footerAddressText').text = BRAND.address;
  }
  if ($w('#footerPhoneLink').length > 0) {
    $w('#footerPhoneLink').text = BRAND.phones.join(' / ');
  }
  if ($w('#footerEmailLink').length > 0) {
    $w('#footerEmailLink').text = BRAND.email;
  }
}
