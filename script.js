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

  if (mainNav.classList.contains('open') && tappedOutsideMenu && tappedOutsideButton) {
    closeDrawer();
  }
});
