'use strict';

const list = document.getElementById('list');
const status = document.getElementById('status');
const count = document.getElementById('count');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
let page = 1;
let total = 0;
const pageSize = 25;

function addText(parent, tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function createCard(enquiry) {
  const card = document.createElement('article');
  addText(card, 'h2', '', enquiry.name);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const phone = document.createElement('a');
  phone.href = `tel:${enquiry.phone}`;
  phone.textContent = enquiry.phone;
  meta.append(phone);
  addText(meta, 'span', '', enquiry.service);
  addText(meta, 'span', '', enquiry.paymentMade ? 'Payment marked as made' : 'Payment not made');
  addText(meta, 'time', '', new Date(enquiry.createdAt).toLocaleString());
  card.append(meta);
  addText(card, 'p', 'message', enquiry.message);
  if (enquiry.hasReceipt) {
    const receiptUrl = `/api/admin/enquiries/${enquiry.id}/receipt`;
    const receiptLink = document.createElement('a');
    receiptLink.className = 'receipt-link';
    receiptLink.href = receiptUrl;
    receiptLink.target = '_blank';
    receiptLink.rel = 'noopener';
    receiptLink.textContent = 'View payment screenshot';
    card.append(receiptLink);

    const receiptImage = document.createElement('img');
    receiptImage.className = 'receipt';
    receiptImage.src = receiptUrl;
    receiptImage.alt = `Payment screenshot submitted by ${enquiry.name}`;
    receiptImage.loading = 'lazy';
    card.append(receiptImage);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete';
  remove.textContent = 'Delete enquiry';
  remove.addEventListener('click', async () => {
    if (!window.confirm('Permanently delete this enquiry?')) return;
    remove.disabled = true;
    status.textContent = '';
    try {
      const response = await fetch(`/api/admin/enquiries/${enquiry.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Unable to delete the enquiry.');
      await loadPage(page);
    } catch (error) {
      status.textContent = error.message;
      remove.disabled = false;
    }
  });
  card.append(remove);
  return card;
}

async function loadPage(requestedPage) {
  status.textContent = '';
  list.replaceChildren();
  try {
    const response = await fetch(`/api/admin/enquiries?page=${requestedPage}`);
    if (!response.ok) throw new Error('Unable to load enquiries. Please refresh and try again.');
    const result = await response.json();
    page = result.page;
    total = result.total;
    result.items.forEach((enquiry) => list.append(createCard(enquiry)));
    count.textContent = total ? `${total} total · Page ${page}` : 'No enquiries yet.';
    previous.disabled = page <= 1;
    next.disabled = page * pageSize >= total;
    if (!result.items.length && total) {
      await loadPage(Math.max(1, Math.ceil(total / pageSize)));
    }
  } catch (error) {
    status.textContent = error.message;
    count.textContent = '';
    previous.disabled = true;
    next.disabled = true;
  }
}

previous.addEventListener('click', () => {
  if (page > 1) loadPage(page - 1);
});
next.addEventListener('click', () => {
  if (page * pageSize < total) loadPage(page + 1);
});
loadPage(page);
