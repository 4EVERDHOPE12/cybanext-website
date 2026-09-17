/* =========================================================
   MOBILE NAVIGATION
========================================================= */

const hamburgerBtn = document.getElementById('hamburgerBtn');

const mainNav = document.getElementById('mainNav');


function toggleDrawer() {

  const isOpen = mainNav.classList.toggle('open');

  hamburgerBtn.classList.toggle('open');

  hamburgerBtn.setAttribute('aria-expanded', isOpen);

}


function closeDrawer() {

  mainNav.classList.remove('open');

  hamburgerBtn.classList.remove('open');

  hamburgerBtn.setAttribute('aria-expanded', 'false');

}


hamburgerBtn.addEventListener('click', toggleDrawer);


document.addEventListener('click', (event) => {

  const tappedOutsideMenu = !mainNav.contains(event.target);

  const tappedOutsideButton = !hamburgerBtn.contains(event.target);

  if (
    mainNav.classList.contains('open') &&
    tappedOutsideMenu &&
    tappedOutsideButton
  ) {

    closeDrawer();

  }

});


/* Close mobile menu after selecting a link */

const navLinks = mainNav.querySelectorAll('a');

navLinks.forEach((link) => {

  link.addEventListener('click', () => {

    if (mainNav.classList.contains('open')) {

      closeDrawer();

    }

  });

});


/* =========================================================
   FORM MESSAGE HELPER
========================================================= */

function showFormMessage(statusMsg, message, type) {

  if (!statusMsg) return;

  statusMsg.textContent = message;

  statusMsg.className = `form-status-message ${type}`;

  statusMsg.style.display = 'block';

  statusMsg.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });

}


/* =========================================================
   APPLICATION FORM
========================================================= */

const applicationForm =
  document.getElementById('applicationForm');


if (applicationForm) {

  applicationForm.addEventListener('submit', async (event) => {

    event.preventDefault();


    const statusMsg =
      document.getElementById('applicationStatus');

    const submitBtn =
      document.getElementById('submitBtn');


    const fullName =
      document.getElementById('fullName');

    const email =
      document.getElementById('email');

    const track =
      document.getElementById('track');

    const reason =
      document.getElementById('reason');


    /* ================= VALIDATION ================= */

    if (!fullName.value.trim()) {

      showFormMessage(
        statusMsg,
        'Please enter your full name.',
        'error'
      );

      fullName.focus();

      return;

    }


    if (!email.value.trim()) {

      showFormMessage(
        statusMsg,
        'Please enter your email address.',
        'error'
      );

      email.focus();

      return;

    }


    if (!email.validity.valid) {

      showFormMessage(
        statusMsg,
        'Please enter a valid email address.',
        'error'
      );

      email.focus();

      return;

    }


    if (!track.value) {

      showFormMessage(
        statusMsg,
        'Please select an internship track.',
        'error'
      );

      track.focus();

      return;

    }


    if (!reason.value.trim()) {

      showFormMessage(
        statusMsg,
        'Please tell us why you want to join this track.',
        'error'
      );

      reason.focus();

      return;

    }


    /* ================= SUBMITTING ================= */

    submitBtn.disabled = true;

    submitBtn.innerHTML = 'Submitting...';


    try {

      const response = await fetch(
        applicationForm.action,
        {
          method: 'POST',

          body: new FormData(applicationForm),

          headers: {
            'Accept': 'application/json'
          }
        }
      );


      /* ================= SUCCESS ================= */

      if (response.ok) {

        showFormMessage(
          statusMsg,
          'Application submitted successfully. We will review your application and get back to you.',
          'success'
        );

        applicationForm.reset();

      }


      /* ================= ERROR ================= */

      else {

        throw new Error('Application submission failed');

      }


    } catch (error) {

      showFormMessage(
        statusMsg,
        'Something went wrong while submitting your application. Please try again.',
        'error'
      );

    }


    /* Restore button */

    submitBtn.disabled = false;

    submitBtn.innerHTML =
      'Submit Application <i class="ti ti-arrow-right" aria-hidden="true"></i>';

  });

}


/* =========================================================
   CONTACT FORM
========================================================= */

const contactForm =
  document.getElementById('contactForm');


if (contactForm) {

  contactForm.addEventListener('submit', async (event) => {

    event.preventDefault();


    const statusMsg =
      document.getElementById('contactStatus');

    const submitBtn =
      document.getElementById('contactSubmitBtn');


    const contactName =
      document.getElementById('contactName');

    const contactEmail =
      document.getElementById('contactEmail');

    const contactReason =
      document.getElementById('contactReason');

    const contactMessage =
      document.getElementById('contactMessage');


    /* ================= VALIDATION ================= */

    if (!contactName.value.trim()) {

      showFormMessage(
        statusMsg,
        'Please enter your name.',
        'error'
      );

      contactName.focus();

      return;

    }


    if (!contactEmail.value.trim()) {

      showFormMessage(
        statusMsg,
        'Please enter your email address.',
        'error'
      );

      contactEmail.focus();

      return;

    }


    if (!contactEmail.validity.valid) {

      showFormMessage(
        statusMsg,
        'Please enter a valid email address.',
        'error'
      );

      contactEmail.focus();

      return;

    }


    if (!contactReason.value) {

      showFormMessage(
        statusMsg,
        'Please select a reason for contacting us.',
        'error'
      );

      contactReason.focus();

      return;

    }


    if (!contactMessage.value.trim()) {

      showFormMessage(
        statusMsg,
        'Please enter your message.',
        'error'
      );

      contactMessage.focus();

      return;

    }


    /* ================= SUBMITTING ================= */

    submitBtn.disabled = true;

    submitBtn.innerHTML = 'Sending...';


    try {

      const response = await fetch(
        contactForm.action,
        {
          method: 'POST',

          body: new FormData(contactForm),

          headers: {
            'Accept': 'application/json'
          }
        }
      );


      /* ================= SUCCESS ================= */

      if (response.ok) {

        showFormMessage(
          statusMsg,
          "Thank you! Your message has been sent. We'll be in touch soon.",
          'success'
        );

        contactForm.reset();

      }


      /* ================= ERROR ================= */

      else {

        throw new Error('Contact submission failed');

      }


    } catch (error) {

      showFormMessage(
        statusMsg,
        'Something went wrong while sending your message. Please try again.',
        'error'
      );

    }


    /* Restore button */

    submitBtn.disabled = false;

    submitBtn.innerHTML =
      'Send Message <i class="ti ti-arrow-right" aria-hidden="true"></i>';

  });

}