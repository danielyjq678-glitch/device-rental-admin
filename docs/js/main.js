// 数码设备租赁 - 商家管理后台 JS
const API = '/api/admin';
let token = '';
let adminRole = '';

// ============================================================
// 初始化
// ============================================================
(function init() {
  token = localStorage.getItem('adminToken');
  if (!token) { window.location.href = '/admin/login.html'; return; }

  const nickname = localStorage.getItem('adminNickname') || '管理员';
  adminRole = localStorage.getItem('adminRole') || 'admin';
  document.getElementById('adminName').textContent = nickname + ' [' + (adminRole === 'super_admin' ? '超管' : (adminRole === 'viewer' ? '查看' : '管理')) + ']';

  loadStats();
  if (adminRole === 'super_admin') document.getElementById('menuAdmins').style.display = '';
})();

// ============================================================
// 工具函数
// ============================================================
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// HTML 转义防 XSS
function escHtml(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// 为受保护的上传文件 URL 附加认证 token（img 标签无法设置 Authorization header）
function fileUrl(url) {
  if (!url || !url.startsWith('/uploads/') || url.startsWith('/uploads/products/')) return url || '';
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

async function fetchApi(url, options = {}) {
  const res = await fetch(API + url, {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...options.headers },
    ...options
  });
  const data = await res.json();
  if (data.code === 401) { localStorage.clear(); window.location.href = '/admin/login.html'; }
  return data;
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function switchSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
  document.getElementById('sec-' + name).classList.add('active');
  document.querySelector(`[data-section="${name}"]`).classList.add('active');

  if (name === 'products') loadProducts();
  if (name === 'devices') loadDevices();
  if (name === 'admins') loadAdmins();
  if (name === 'claims') loadClaims(2);
  if (name === 'verifications') loadVerifications(1);
  if (name === 'deposits') loadDeposits(1);
  if (name === 'orders') loadOrders();
}

function logout() {
  localStorage.clear();
  window.location.href = '/admin/login.html';
}

// ============================================================
// 数据总览
// ============================================================
let _prevCounts = {};

async function loadStats() {
  const res = await fetchApi('/stats');
  if (res.code !== 0) return;

  const d = res.data;
  document.getElementById('statsCards').innerHTML = `
    <div class="stat-card blue"><div class="stat-label">今日订单数</div><div class="stat-value">${d.todayOrders}</div></div>
    <div class="stat-card green"><div class="stat-label">总订单数</div><div class="stat-value">${d.totalOrders}</div></div>
    <div class="stat-card purple"><div class="stat-label">总营收(元)</div><div class="stat-value">${Number(d.totalRevenue).toFixed(2)}</div></div>
    <div class="stat-card orange"><div class="stat-label">待审核认证</div><div class="stat-value">${d.pendingVerifications}</div></div>
    <div class="stat-card red"><div class="stat-label">待审核押金</div><div class="stat-value">${d.pendingDeposits}</div></div>
  `;

  // 刷新侧边栏红点
  updateBadge('badge-verifications', d.pendingVerifications);
  updateBadge('badge-deposits', d.pendingDeposits);
  updateBadge('badge-claims', d.pendingClaims || 0);
  updateBadge('badge-orders', d.pendingShip || 0);

  // 检测新增待发货订单，弹出提醒
  if (_prevCounts.pendingShip !== undefined && d.pendingShip > _prevCounts.pendingShip) {
    const diff = d.pendingShip - _prevCounts.pendingShip;
    showToast(`🔔 有 ${diff} 个新订单已付款，请及时发货`);
  }
  _prevCounts = d;
}

function updateBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : count;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

// 每10秒刷新红点
setInterval(() => { if (token) loadStats(); }, 10000);

// ============================================================
// 轮播图管理
// ============================================================

async function loadBanners() {
  const res = await fetchApi('/banners');
  const banners = res.code === 0 ? res.data : [];
  const tbody = document.getElementById('bannerTable');
  if (banners.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">暂无轮播图</td></tr>';
  } else {
    tbody.innerHTML = banners.map(b => `
      <tr>
        <td>${b.id}</td>
        <td><img src="${b.image_url}" style="width:120px;height:60px;object-fit:cover;border-radius:4px" onerror="this.style.display='none'" /></td>
        <td>${b.title || '-'}</td>
        <td>${b.sort}</td>
        <td>${b.status === 1 ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-gray">停用</span>'}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="editBanner(${b.id})">编辑</button>
            <button class="btn btn-sm btn-danger" onclick="deleteBanner(${b.id})">删除</button>
          </div>
        </td>
      </tr>
    `).join('');
  }
}

function showBannerModal(editId = null) {
  if (editId) {
    document.getElementById('bannerModalTitle').textContent = '编辑轮播图';
    document.getElementById('bannerEditId').value = editId;
  } else {
    document.getElementById('bannerModalTitle').textContent = '添加轮播图';
    document.getElementById('bannerEditId').value = '';
    document.getElementById('banner_image').value = '';
    document.getElementById('banner_title').value = '';
    document.getElementById('banner_sort').value = '0';
    document.getElementById('banner_status').value = '1';
    document.getElementById('bannerPreview').src = '';
    document.getElementById('bannerPreview').style.display = 'none';
  }
  document.getElementById('bannerModal').classList.add('show');
}

async function editBanner(id) {
  const res = await fetchApi('/banners');
  if (res.code !== 0) return;
  const banner = res.data.find(b => b.id === id);
  if (!banner) return;
  showBannerModal(id);
  document.getElementById('banner_image').value = banner.image_url;
  document.getElementById('banner_title').value = banner.title || '';
  document.getElementById('banner_sort').value = banner.sort;
  document.getElementById('banner_status').value = banner.status;
  document.getElementById('bannerPreview').src = banner.image_url;
  document.getElementById('bannerPreview').style.display = '';
}

async function saveBanner() {
  const id = document.getElementById('bannerEditId').value;
  const data = {
    image_url: document.getElementById('banner_image').value.trim(),
    title: document.getElementById('banner_title').value.trim(),
    sort: parseInt(document.getElementById('banner_sort').value) || 0,
    status: parseInt(document.getElementById('banner_status').value)
  };
  if (!data.image_url) { showToast('请填写图片URL或上传图片'); return; }

  const url = id ? '/banners/' + id : '/banners';
  const method = id ? 'PUT' : 'POST';
  const res = await fetchApi(url, { method, body: JSON.stringify(data) });
  if (res.code === 0) {
    showToast(id ? '更新成功' : '添加成功');
    closeModal('bannerModal');
    loadBanners();
  } else {
    showToast(res.msg);
  }
}

async function deleteBanner(id) {
  if (!confirm('确定删除该轮播图？')) return;
  const res = await fetchApi('/banners/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadBanners(); }
  else showToast(res.msg);
}

async function uploadBannerImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    showToast('上传中...');
    const res = await fetch('/api/upload/admin/image', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    const data = await res.json();
    if (data.code === 0) {
      const url = window.location.origin + data.data.url;
      document.getElementById('banner_image').value = url;
      document.getElementById('bannerPreview').src = url;
      document.getElementById('bannerPreview').style.display = '';
      showToast('上传成功');
    } else {
      showToast(data.msg || '上传失败');
    }
  } catch (err) {
    showToast('上传失败');
  }
  event.target.value = '';
}

// ============================================================
// 商品管理
// ============================================================
let productPage = 1;

async function loadProducts(page = 1) {
  productPage = page;
  const res = await fetchApi(`/products?page=${page}&pageSize=10`);
  if (res.code !== 0) return;

  const { list, total } = res.data;
  const tbody = document.getElementById('productTable');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">暂无商品数据</td></tr>';
  } else {
    tbody.innerHTML = list.map(p => `
      <tr>
        <td>${p.id}</td>
        <td>${getFirstImage(p.images) ? `<img src="${getFirstImage(p.images)}" class="img-thumb" style="width:48px;height:48px" onerror="this.style.display='none'" />` : '-'}</td>
        <td>${escHtml(p.name)}</td>
        <td>${p.category_name || '-'}</td>
        <td>¥${p.daily_price}</td>
        <td>¥${p.original_deposit}</td>
        <td>${p.stock}</td>
        <td>${p.status === 1 ? '<span class="tag tag-green">上架</span>' : '<span class="tag tag-gray">下架</span>'}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="editProduct(${p.id})">编辑</button>
            <button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">删除</button>
          </div>
        </td>
      </tr>
    `).join('');
  }
  // 分页
  const totalPages = Math.ceil(total / 10);
  document.getElementById('productPagination').innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} onclick="loadProducts(${page - 1})">上一页</button>
    <span class="current">${page} / ${totalPages || 1}</span>
    <button ${page >= totalPages ? 'disabled' : ''} onclick="loadProducts(${page + 1})">下一页</button>
  `;
}

async function showProductModal(editId = null, productData = null) {
  // 加载分类选项
  const catRes = await fetchApi('/categories');
  const cats = catRes.code === 0 ? catRes.data : [];
  document.getElementById('prod_category').innerHTML = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  if (editId && productData) {
    document.getElementById('productModalTitle').textContent = '编辑商品';
    document.getElementById('productEditId').value = editId;
    document.getElementById('prod_name').value = productData.name || '';
    document.getElementById('prod_daily_price').value = productData.daily_price || '';
    document.getElementById('prod_original_deposit').value = productData.original_deposit || '';
    document.getElementById('prod_stock').value = productData.stock || 0;
    document.getElementById('prod_status').value = productData.status;
    document.getElementById('prod_tags').value = productData.tags || '';
    document.getElementById('prod_description').value = productData.description || '';
    document.getElementById('prod_images').value = Array.isArray(productData.images) ? productData.images.join(',') : (productData.images || '');
    document.getElementById('prod_category').value = productData.category_id;
    updateImagePreview(document.getElementById('prod_images').value);
    // 加载阶梯定价
    loadTierRows(editId);
  } else {
    document.getElementById('productModalTitle').textContent = '新增商品';
    document.getElementById('productEditId').value = '';
    ['prod_name','prod_daily_price','prod_original_deposit','prod_stock','prod_tags','prod_description','prod_images'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('prod_stock').value = '0';
    document.getElementById('prod_status').value = '1';
  }
  document.getElementById('productModal').classList.add('show');
}

async function editProduct(id) {
  try {
    const res = await fetch('/api/products/' + id);
    const data = await res.json();
    if (data.code === 0) {
      showProductModal(id, data.data);
    } else {
      showToast('加载商品信息失败');
    }
  } catch (err) {
    showToast('网络请求失败');
  }
}

async function saveProduct() {
  const id = document.getElementById('productEditId').value;
  const data = {
    category_id: parseInt(document.getElementById('prod_category').value),
    name: document.getElementById('prod_name').value.trim(),
    description: document.getElementById('prod_description').value.trim(),
    daily_price: parseFloat(document.getElementById('prod_daily_price').value),
    original_deposit: parseFloat(document.getElementById('prod_original_deposit').value),
    images: document.getElementById('prod_images').value.trim().split(',').map(s => s.trim()).filter(Boolean),
    stock: parseInt(document.getElementById('prod_stock').value) || 0,
    status: parseInt(document.getElementById('prod_status').value),
    tags: document.getElementById('prod_tags').value.trim()
  };

  if (!data.name || !data.daily_price || !data.original_deposit) {
    showToast('请填写商品名称、日租价和原价押金'); return;
  }

  const url = id ? `/products/${id}` : '/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetchApi(url, { method, body: JSON.stringify(data) });

  if (res.code === 0) {
    showToast(id ? '商品更新成功' : '商品添加成功');
    closeModal('productModal');
    loadProducts(productPage);
  } else {
    showToast(res.msg);
  }
}

async function deleteProduct(id) {
  if (!confirm('确定要删除该商品吗？')) return;
  const res = await fetchApi(`/products/${id}`, { method: 'DELETE' });
  if (res.code === 0) { showToast('删除成功'); loadProducts(productPage); }
  else showToast(res.msg);
}

// ============================================================
// 阶梯定价管理
// ============================================================

async function loadTierRows(productId) {
  const tbody = document.querySelector('#tierTable tbody');
  if (!productId) { tbody.innerHTML = ''; return; }
  try {
    const res = await fetchApi('/product-tiers/' + productId);
    const tiers = res.code === 0 ? res.data : [];
    tbody.innerHTML = tiers.map(t => `
      <tr>
        <td><input type="number" value="${t.min_days}" data-id="${t.id}" data-field="min_days" style="width:80px;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px" /></td>
        <td><input type="number" step="0.01" value="${t.daily_price}" data-id="${t.id}" data-field="daily_price" style="width:100px;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px" /></td>
        <td><button class="btn btn-sm btn-success" onclick="saveTier(${t.id}, ${productId})">保存</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTier(${t.id}, ${productId})">删除</button></td>
      </tr>
    `).join('');
  } catch (e) { tbody.innerHTML = ''; }
}

function addTierRow() {
  const productId = document.getElementById('productEditId').value;
  if (!productId) { showToast('请先保存商品后再添加阶梯定价'); return; }
  const tbody = document.querySelector('#tierTable tbody');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="number" value="" placeholder="如: 3" data-id="new" data-field="min_days" style="width:80px;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px" /></td>
    <td><input type="number" step="0.01" value="" placeholder="如: 32.00" data-id="new" data-field="daily_price" style="width:100px;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px" /></td>
    <td><button class="btn btn-sm btn-success" onclick="saveNewTier(this, ${productId})">保存</button></td>
  `;
  tbody.appendChild(row);
}

async function saveNewTier(btn, productId) {
  const row = btn.parentElement.parentElement;
  const minDays = parseInt(row.querySelector('[data-field="min_days"]').value);
  const dailyPrice = parseFloat(row.querySelector('[data-field="daily_price"]').value);
  if (!minDays || !dailyPrice) { showToast('请填写起租天数和每日租金'); return; }
  const res = await fetchApi('/product-tiers/' + productId, { method: 'POST', body: JSON.stringify({ min_days: minDays, daily_price: dailyPrice }) });
  if (res.code === 0) { showToast('添加成功'); loadTierRows(productId); }
  else showToast(res.msg);
}

async function saveTier(tierId, productId) {
  const row = document.querySelector(`[data-id="${tierId}"][data-field="min_days"]`).closest('tr');
  const minDays = parseInt(row.querySelector('[data-field="min_days"]').value);
  const dailyPrice = parseFloat(row.querySelector('[data-field="daily_price"]').value);
  if (!minDays || !dailyPrice) { showToast('请填写完整'); return; }
  const res = await fetchApi('/product-tiers/' + tierId, {
    method: 'PUT', body: JSON.stringify({ min_days: minDays, daily_price: dailyPrice })
  });
  if (res.code === 0) showToast('已更新');
  else showToast(res.msg);
}

async function deleteTier(tierId, productId) {
  if (!confirm('确定删除该阶梯定价？')) return;
  const res = await fetchApi('/product-tiers/' + tierId, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadTierRows(productId); }
  else showToast(res.msg);
}

// 上传商品图片
async function uploadProductImage(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast('上传中...');
    const res = await fetch('/api/upload/admin/image?type=product', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    const data = await res.json();
    if (data.code === 0) {
      // 产品图片用 /images/products/ 路径
      const url = data.data.url;
      const input = document.getElementById('prod_images');
      const current = input.value.trim();
      input.value = current ? current + ',' + url : url;
      // 显示预览
      updateImagePreview(input.value);
      showToast('上传成功');
    } else {
      showToast(data.msg || '上传失败');
    }
  } catch (err) {
    showToast('上传失败');
  }
  // 清空文件选择
  event.target.value = '';
}

// 更新图片预览
function updateImagePreview(imagesStr) {
  const container = document.getElementById('imagePreview');
  if (!imagesStr) { container.innerHTML = ''; return; }
  const urls = imagesStr.split(',').map(s => s.trim()).filter(Boolean);
  container.innerHTML = urls.map(url => `
    <div style="position:relative;display:inline-block">
      <img src="${url}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid #f0f0f0" onerror="this.style.display='none'" />
      <span style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;background:#ff4d4f;color:#fff;border-radius:50%;text-align:center;line-height:18px;font-size:12px;cursor:pointer"
            onclick="removeImage('${url}')">x</span>
    </div>
  `).join('');
}

function removeImage(url) {
  const input = document.getElementById('prod_images');
  const urls = input.value.split(',').map(s => s.trim()).filter(Boolean).filter(u => u !== url);
  input.value = urls.join(',');
  updateImagePreview(input.value);
}

// ============================================================
// 认证审核
// ============================================================
let verifStatus = 1, verifPage = 1;

function switchVerificationTab(status) {
  verifStatus = status;
  document.querySelectorAll('#sec-verifications .tab-item').forEach((t, i) => t.classList.toggle('active', i === (status === 1 ? 0 : 1)));
  loadVerifications(status);
}

async function loadVerifications(status, page = 1) {
  verifStatus = status; verifPage = page;
  const res = await fetchApi(`/verifications?status=${status}&page=${page}`);
  if (res.code !== 0) return;

  const { list, total } = res.data;
  const tbody = document.getElementById('verificationTable');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">暂无数据</td></tr>';
  } else {
    tbody.innerHTML = list.map(v => `
      <tr>
        <td>${v.id}</td>
        <td>${v.nickname || '-'}</td>
        <td>${v.auth_type === 1 ? '🎓 大学生' : '👤 普通用户'}</td>
        <td>${escHtml(v.real_name)}</td>
        <td>${new Date(v.created_at).toLocaleString('zh-CN')}</td>
        <td>${statusTag(v.status)}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-primary" onclick="showVerificationDetail(${v.id})">查看详情</button>
            ${v.status !== 1 ? `<button class="btn btn-sm btn-danger" onclick="delVerification(${v.id})">删除</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  }
  const totalPages = Math.ceil(total / 10) || 1;
  document.getElementById('verificationPagination').innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} onclick="loadVerifications(verifStatus, ${page - 1})">上一页</button>
    <span class="current">${page} / ${totalPages}</span>
    <button ${page >= totalPages ? 'disabled' : ''} onclick="loadVerifications(verifStatus, ${page + 1})">下一页</button>
  `;
}

async function showVerificationDetail(id) {
  const res = await fetchApi(`/verifications/${id}`);
  if (res.code !== 0) return;
  const v = res.data;

  const images = [];
  if (v.id_card_front_img) images.push(['身份证正面', v.id_card_front_img]);
  if (v.id_card_back_img) images.push(['身份证反面', v.id_card_back_img]);
  if (v.sesame_img) images.push(['芝麻信用分', v.sesame_img]);
  if (v.student_card_img) images.push(['学生证', v.student_card_img]);
  if (v.student_id_card_img) images.push(['学生卡', v.student_id_card_img]);
  if (v.xuexin_img) images.push(['学信网证明', v.xuexin_img]);

  document.getElementById('verificationDetail').innerHTML = `
    <div style="margin-bottom:16px">
      <strong>认证类型：</strong>${v.auth_type === 1 ? '大学生认证' : '普通用户认证'}<br/>
      <strong>真实姓名：</strong>${escHtml(v.real_name)}<br/>
      <strong>身份证号：</strong>${v.id_card}<br/>
      ${v.auth_type === 1 ? `
        <strong>学校：</strong>${v.school_name}<br/>
        <strong>学号：</strong>${v.student_id}<br/>
        <strong>入学时间：</strong>${v.enrollment_year}<br/>
        <strong>毕业时间：</strong>${v.graduation_year}<br/>
      ` : ''}
      <strong>提交时间：</strong>${new Date(v.created_at).toLocaleString('zh-CN')}<br/>
      <strong>状态：</strong>${statusTag(v.status)}
      ${v.reject_reason ? `<br/><strong style="color:#ff4d4f">拒绝原因：</strong>${v.reject_reason}` : ''}
    </div>
    <div><strong>上传材料：</strong></div>
    <div style="margin-top:8px">${images.map(([label, url]) => `
      <div style="display:inline-block;margin:4px;text-align:center">
        <img src="${fileUrl(url)}" style="width:140px;height:140px;object-fit:cover;border-radius:4px;cursor:pointer" onclick="window.open('${fileUrl(url)}')" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22140%22 height=%22140%22><rect fill=%22%23f5f5f5%22 width=%22140%22 height=%22140%22/><text fill=%22%23999%22 x=%2270%22 y=%2275%22 text-anchor=%22middle%22 font-size=%2212%22>加载失败</text></svg>'" />
        <div style="font-size:12px;color:#666">${label}</div>
      </div>
    `).join('')}</div>
  `;

  if (v.status === 1) {
    document.getElementById('verificationActions').innerHTML = `
      <input id="rejectReason" placeholder="拒绝原因（拒绝时必填）" style="flex:1;padding:8px 12px;border:1px solid #d9d9d9;border-radius:4px" />
      <button class="btn btn-success" onclick="reviewVerification(${v.id}, 'approve')">✅ 通过</button>
      <button class="btn btn-danger" onclick="reviewVerification(${v.id}, 'reject')">❌ 拒绝</button>
    `;
  } else {
    document.getElementById('verificationActions').innerHTML = '';
  }

  document.getElementById('verificationModal').classList.add('show');
}

async function reviewVerification(id, action) {
  const body = { action };
  if (action === 'reject') {
    const reason = document.getElementById('rejectReason').value.trim();
    if (!reason) { showToast('拒绝时必须填写原因'); return; }
    body.reject_reason = reason;
  }

  const res = await fetchApi(`/verifications/${id}/review`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.code === 0) {
    showToast(action === 'approve' ? '认证审核已通过' : '已拒绝该认证');
    closeModal('verificationModal');
    loadVerifications(verifStatus, verifPage);
    loadStats();
  } else {
    showToast(res.msg);
  }
}

// ============================================================
// 押金审核
// ============================================================
let depositStatus = 1, depositPage = 1, selectedDeposits = new Set();

function switchDepositTab(status) {
  depositStatus = status; depositPage = 1; selectedDeposits.clear();
  document.querySelectorAll('#sec-deposits .tab-item').forEach((t, i) => t.classList.toggle('active', i === (status === 1 ? 0 : 1)));
  document.getElementById('depositBatchBar').style.display = status === 1 ? 'flex' : 'none';
  document.getElementById('selectAll').checked = false;
  loadDeposits(status);
}

async function loadDeposits(status, page = 1) {
  depositStatus = status; depositPage = page;
  const res = await fetchApi(`/deposit-orders?status=${status}&page=${page}`);
  if (res.code !== 0) return;

  const { list, total } = res.data;
  const tbody = document.getElementById('depositTable');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">暂无数据</td></tr>';
  } else {
    tbody.innerHTML = list.map(o => `
      <tr>
        <td>${status === 1 ? `<input type="checkbox" value="${o.id}" ${selectedDeposits.has(o.id) ? 'checked' : ''} onchange="toggleDeposit(${o.id})" />` : ''}</td>
        <td>${o.order_no}</td>
        <td>${o.nickname || '-'}</td>
        <td>${o.product_name || '-'}${o.items && o.items.length > 1 ? ` <span class="tag tag-blue">等${o.items.length}件</span>` : ''}</td>
        <td>${o.rental_start_date} ~ ${o.rental_end_date}</td>
        <td>${o.rental_days}天</td>
        <td>¥${o.total_rent}</td>
        <td>¥${o.estimated_deposit}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm btn-primary" onclick="showDepositDetail(${o.id})">审核</button>
            ${o.deposit_status !== 1 ? `<button class="btn btn-sm btn-danger" onclick="delDeposit(${o.id})">删除</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  }
  const totalPages = Math.ceil(total / 10) || 1;
  document.getElementById('depositPagination').innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} onclick="loadDeposits(depositStatus, ${page - 1})">上一页</button>
    <span class="current">${page} / ${totalPages}</span>
    <button ${page >= totalPages ? 'disabled' : ''} onclick="loadDeposits(depositStatus, ${page + 1})">下一页</button>
  `;
}

function toggleDeposit(id) {
  if (selectedDeposits.has(id)) selectedDeposits.delete(id);
  else selectedDeposits.add(id);
}

function toggleSelectAll() {
  const checked = document.getElementById('selectAll').checked;
  const checkboxes = document.querySelectorAll('#depositTable input[type="checkbox"]');
  checkboxes.forEach(cb => {
    cb.checked = checked;
    const id = parseInt(cb.value);
    if (checked) selectedDeposits.add(id);
    else selectedDeposits.delete(id);
  });
}

async function showDepositDetail(id) {
  const res = await fetchApi(`/deposit-orders/${id}`);
  if (res.code !== 0) return;
  const { order, verification } = res.data;

  // 订单信息
  let itemsHtml = '';
  if (order.items && order.items.length > 0) {
    itemsHtml = order.items.map(it => `
      <div style="margin:4px 0;padding:6px 8px;background:#fafafa;border-radius:4px">
        ${it.product_name} — ${it.rental_start_date}~${it.rental_end_date}（${it.rental_days}天）¥${it.daily_price}/天 小计 ¥${it.total_rent}
      </div>
    `).join('');
    itemsHtml = `<div style="margin-top:4px">${itemsHtml}</div>`;
  }

  let html = `
    <div style="margin-bottom:16px">
      <strong>订单号：</strong>${order.order_no}<br/>
      <strong>用户：</strong>${order.nickname || '-'}<br/>
      <strong>商品：</strong>${order.product_name || (order.items && order.items.length > 0 ? order.items[0].product_name : '-')}${order.items && order.items.length > 1 ? ` <em>等${order.items.length}件</em>` : ''}<br/>
      ${itemsHtml}
      <strong>租赁起止：</strong>${order.rental_start_date} ~ ${order.rental_end_date}（${order.rental_days}天）<br/>
      <strong>日租价：</strong>¥${order.daily_price}<br/>
      <strong>总租金：</strong>¥${order.total_rent}<br/>
      <strong>系统预估押金：</strong>¥${order.estimated_deposit}
      ${order.items && order.items.length > 0 ? `
        <div style="margin-top:8px"><strong>逐项押金设置：</strong></div>
        ${order.items.map((it, i) => `
          <div style="margin:4px 0;padding:6px 8px;background:#fafafa;border-radius:4px;display:flex;align-items:center;gap:8px">
            <span style="flex:1;font-size:13px">${it.product_name}（预估 ¥${it.estimated_deposit || 0}）</span>
            <input id="depItem${it.id}" type="number" step="0.01" value="${it.final_deposit !== null && it.final_deposit !== undefined ? it.final_deposit : (it.estimated_deposit || 0)}" style="width:100px;padding:4px 8px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px" />
            <span style="font-size:12px;color:#999">元</span>
          </div>
        `).join('')}
      ` : ''}
    </div>
  `;

  // 用户认证信息
  if (verification) {
    html += `
      <hr style="margin:12px 0;border-color:#f0f0f0" />
      <div><strong>用户认证信息：</strong></div>
      <div style="margin-top:8px">
        类型：${verification.auth_type === 1 ? '🎓 大学生认证' : '👤 普通用户认证'}<br/>
        姓名：${verification.real_name}<br/>
        身份证：${maskIdCard(verification.id_card)}
        ${verification.auth_type === 1 ? `<br/>学校：${verification.school_name}<br/>学号：${verification.student_id}` : ''}
      </div>
      <div style="margin-top:8px"><strong>认证材料：</strong></div>
      <div>${[
        verification.id_card_front_img && ['身份证正面', verification.id_card_front_img],
        verification.id_card_back_img && ['身份证反面', verification.id_card_back_img],
        verification.sesame_img && ['芝麻信用分', verification.sesame_img],
        verification.student_card_img && ['学生证', verification.student_card_img],
        verification.student_id_card_img && ['学生卡', verification.student_id_card_img],
        verification.xuexin_img && ['学信网证明', verification.xuexin_img]
      ].filter(Boolean).map(([label, url]) => `
        <span style="display:inline-block;margin:4px;text-align:center">
          <img src="${fileUrl(url)}" style="width:100px;height:100px;object-fit:cover;border-radius:4px;cursor:pointer" onclick="window.open('${fileUrl(url)}')" onerror="this.style.display='none'" />
          <div style="font-size:11px;color:#666">${label}</div>
        </span>
      `).join('')}</div>
    `;
  }

  document.getElementById('depositDetail').innerHTML = html;

  if (order.deposit_status === 1) {
    const hasItems = order.items && order.items.length > 1;
    document.getElementById('depositActions').innerHTML = `
      ${!hasItems ? `
      <div style="display:flex;align-items:center;gap:12px">
        <label style="white-space:nowrap;font-size:13px">最终押金(元)：</label>
        <input type="number" id="finalDeposit" value="${order.estimated_deposit}" step="0.01"
               style="width:140px;padding:8px 12px;border:1px solid #d9d9d9;border-radius:4px;font-size:14px" />
      </div>` : ''}
      <div style="display:flex;align-items:center;gap:8px">
        <input id="depositRemark" placeholder="审核备注（可选）" style="flex:1;padding:8px 12px;border:1px solid #d9d9d9;border-radius:4px" />
      </div>
      <button class="btn btn-danger" onclick="reviewDeposit(${order.id}, 'reject')">❌ 拒绝</button>
      <button class="btn btn-success" onclick="reviewDeposit(${order.id}, 'approve')">✅ 通过</button>
    `;
  } else {
    document.getElementById('depositActions').innerHTML = `
      <span style="color:#999">该订单押金已审核（${order.deposit_status === 2 ? '已通过' : '已拒绝'}）</span>
    `;
  }

  document.getElementById('depositModal').classList.add('show');
}

async function reviewDeposit(id, action) {
  const body = { action };
  if (action === 'approve') {
    // 检查是否有逐项押金输入
    const itemInputs = document.querySelectorAll('[id^="depItem"]');
    if (itemInputs.length > 0) {
      body.item_deposits = [];
      itemInputs.forEach(inp => {
        const itemId = parseInt(inp.id.replace('depItem', ''));
        body.item_deposits.push({ item_id: itemId, final_deposit: parseFloat(inp.value) || 0 });
      });
    } else {
      const deposit = document.getElementById('finalDeposit')?.value;
      body.final_deposit = parseFloat(deposit) || 0;
    }
    body.remark = document.getElementById('depositRemark')?.value?.trim() || '';
  } else {
    const remark = document.getElementById('depositRemark') || { value: '' };
    body.reject_reason = '后台审核拒绝';
    if (remark.value.trim()) body.reject_reason = remark.value.trim();
  }

  // 拒绝时弹窗确认
  if (action === 'reject') {
    const reason = prompt('请输入拒绝原因：');
    if (!reason) return;
    body.reject_reason = reason;
  }

  const res = await fetchApi(`/deposit-orders/${id}/review`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.code === 0) {
    showToast(action === 'approve' ? '押金审核已通过' : '已拒绝该订单');
    closeModal('depositModal');
    loadDeposits(depositStatus, depositPage);
    loadStats();
  } else {
    showToast(res.msg);
  }
}

async function batchApproveDeposits() {
  if (selectedDeposits.size === 0) { showToast('请选择要审核的订单'); return; }
  const finalDeposits = {};
  for (const id of selectedDeposits) {
    const d = prompt(`订单ID ${id} 的最终押金金额（默认用预估值）：`);
    if (d !== null) finalDeposits[id] = parseFloat(d) || 0;
  }
  const res = await fetchApi('/deposit-orders/batch-review', {
    method: 'POST',
    body: JSON.stringify({ order_ids: [...selectedDeposits], action: 'approve', final_deposits: finalDeposits })
  });
  if (res.code === 0) { showToast(res.msg); selectedDeposits.clear(); loadDeposits(1); loadStats(); }
  else showToast(res.msg);
}

async function batchRejectDeposits() {
  if (selectedDeposits.size === 0) { showToast('请选择要拒绝的订单'); return; }
  const remark = prompt('批量拒绝原因：') || '批量审核拒绝';
  const res = await fetchApi('/deposit-orders/batch-review', {
    method: 'POST',
    body: JSON.stringify({ order_ids: [...selectedDeposits], action: 'reject', remark })
  });
  if (res.code === 0) { showToast(res.msg); selectedDeposits.clear(); loadDeposits(1); loadStats(); }
  else showToast(res.msg);
}

// ============================================================
// 订单管理
// ============================================================
let orderPage = 1;
let selectedOrders = new Set();

async function loadOrders(page = 1) {
  orderPage = page;
  const status = document.getElementById('orderStatusFilter')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 10 });
  if (status) params.set('status', status);
  const res = await fetchApi(`/orders?${params.toString()}`);
  if (res.code !== 0) return;

  const { list, total } = res.data;
  const tbody = document.getElementById('orderTable');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="14">暂无订单数据</td></tr>';
  } else {
    selectedOrders.clear();
    tbody.innerHTML = list.map(o => `
      <tr>
        <td>${(o.status === 0 || o.status === 2 || o.status === 5) ? `<input type="checkbox" value="${o.id}" onchange="toggleOrderSelect(${o.id})" />` : ''}</td>
        <td>${o.order_no}</td>
        <td style="font-size:12px">${(o.ordered_at || '').substring(0, 16)}</td>
        <td>${o.nickname || '-'}</td>
        <td>${o.product_name}</td>
        <td>${o.rental_start_date} ~ ${o.rental_end_date}</td>
        <td>${o.rental_days}天</td>
        <td>${o.tracking_company ? `<span style="font-size:12px">${o.tracking_company}<br><small>${o.tracking_no || '-'}</small></span>` : '-'}</td>
        <td>¥${o.total_rent}</td>
        <td>${o.insurance_price > 0 ? `<span class="tag tag-blue">${o.insurance_name || '已购'}<br><small>¥${o.insurance_price}</small></span>` : '<span class="tag tag-gray">未购买</span>'}</td>
        <td><b>¥${(parseFloat(o.total_rent) + (parseFloat(o.insurance_price) || 0)).toFixed(2)}</b></td>
        <td>¥${o.final_deposit || '-'}</td>
        <td>${orderStatusTag(o.status)}</td>
        <td>
          <div class="btn-group">
            ${o.status === 2 ? `<button class="btn btn-sm btn-primary" onclick="changeOrderStatus(${o.id}, 3, ${o.product_id})">发货</button>` : ''}
            ${o.status === 3 ? `<button class="btn btn-sm btn-primary" onclick="changeOrderStatus(${o.id}, 4)">开始租赁</button>` : ''}
            ${(o.status === 3 || o.status === 4) && !o.device_id ? `<button class="btn btn-sm" onclick="assignDevice(${o.id}, ${o.product_id})">分配设备</button>` : ''}
            ${o.status === 4 ? `<button class="btn btn-sm btn-warning" onclick="changeOrderStatus(${o.id}, 6)">归还验收</button>` : ''}
            ${o.status === 6 ? `<button class="btn btn-sm btn-success" onclick="showReturnReview(${o.id})">验收处理</button>` : ''}
            ${(o.status === 0 || o.status === 2 || o.status === 5) ? `<button class="btn btn-sm btn-danger" onclick="delOrder(${o.id})">删除</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  }
  const totalPages = Math.ceil(total / 10) || 1;
  document.getElementById('orderPagination').innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} onclick="loadOrders(${page - 1})">上一页</button>
    <span class="current">${page} / ${totalPages}</span>
    <button ${page >= totalPages ? 'disabled' : ''} onclick="loadOrders(${page + 1})">下一页</button>
  `;
}

function toggleOrderSelect(id) {
  if (selectedOrders.has(id)) selectedOrders.delete(id);
  else selectedOrders.add(id);
  document.getElementById('orderBatchBar').style.display = selectedOrders.size > 0 ? '' : 'none';
}
function toggleOrderSelectAll() {
  const checked = document.getElementById('orderSelectAll').checked;
  document.querySelectorAll('#orderTable input[type="checkbox"]').forEach(cb => {
    cb.checked = checked;
    const id = parseInt(cb.value);
    if (checked) selectedOrders.add(id);
    else selectedOrders.delete(id);
  });
  document.getElementById('orderBatchBar').style.display = selectedOrders.size > 0 ? '' : 'none';
}
async function batchDeleteOrders() {
  if (!confirm(`确定删除选中的 ${selectedOrders.size} 个订单？此操作不可撤销。`)) return;
  for (const id of selectedOrders) {
    await fetchApi('/orders/' + id, { method: 'DELETE' });
  }
  showToast(`已删除 ${selectedOrders.size} 个订单`);
  selectedOrders.clear();
  document.getElementById('orderBatchBar').style.display = 'none';
  document.getElementById('orderSelectAll').checked = false;
  loadOrders(orderPage);
  loadStats();
}

async function changeOrderStatus(id, status) {
  const labels = { 3: '确认发货', 4: '确认开始租赁', 5: '确认完成订单', 6: '确认设备已归还' };
  if (!confirm(`确定${labels[status]}？`)) return;

  const res = await fetchApi(`/orders/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status })
  });
  if (res.code === 0) { showToast(res.msg); loadOrders(orderPage); loadStats(); }
  else showToast(res.msg);
}

async function showReturnReview(orderId) {
  const damageFee = prompt('损坏扣款金额（元），无损坏填0或留空：', '0');
  if (damageFee === null) return;

  // 归还物流信息
  const companies = ['顺丰速运', '中通快递', '圆通速递', '韵达快递', '邮政EMS', '京东物流', '极兔速递', '其他'];
  const companyList = companies.map((c, i) => (i + 1) + '. ' + c).join('\n');
  const companyChoice = prompt('选择归还快递公司（可取消跳过）：\n\n' + companyList, '');
  let trackingCompany = '', trackingNo = '';
  if (companyChoice !== null) {
    const ci = parseInt(companyChoice) - 1;
    if (ci >= 0 && ci < companies.length) {
      trackingCompany = companies[ci];
      const tn = prompt('输入归还快递单号（可取消跳过）：');
      if (tn && tn.trim()) trackingNo = tn.trim();
    }
  }

  const fee = parseFloat(damageFee) || 0;
  const action = fee > 0 ? 'damage' : 'complete';
  const remark = prompt('验收备注（可选）：', '');

  const body = { action, damage_fee: fee, remark: remark || '' };
  if (trackingCompany) body.return_tracking_company = trackingCompany;
  if (trackingNo) body.return_tracking_no = trackingNo;

  const res = await fetchApi(`/orders/${orderId}/return-review`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
  if (res.code === 0) { showToast('验收完成'); loadOrders(orderPage); loadStats(); }
  else showToast(res.msg);
}

// ============================================================
// ============================================================
// 报修管理
// ============================================================
let claimPage = 1;
let claimStatus = 2;
let claimImagesCache = {};

function switchClaimTab(status) {
  claimStatus = status;
  document.querySelectorAll('#sec-claims .tab-item').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && status === 2) || (i === 1 && status === 3) || (i === 2 && status === 4));
  });
  loadClaims(status);
}

async function loadClaims(status, page = 1) {
  claimPage = page;
  claimStatus = status || claimStatus;
  const res = await fetchApi(`/claims?status=${claimStatus}&page=${page}&pageSize=10`);
  if (res.code !== 0) return;

  const { list, total } = res.data;
  const tbody = document.getElementById('claimTable');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">暂无报修申请</td></tr>';
    const totalPages = Math.ceil(total / 10) || 1;
    document.getElementById('claimPagination').innerHTML = `
      <button ${page <= 1 ? 'disabled' : ''} onclick="loadClaims(${claimStatus}, ${page - 1})">上一页</button>
      <span class="current">${page} / ${totalPages}</span>
      <button ${page >= totalPages ? 'disabled' : ''} onclick="loadClaims(${claimStatus}, ${page + 1})">下一页</button>
    `;
    return;
  }

  list.forEach(c => { claimImagesCache[c.id] = c.claim_imgs; });

  const statusMap = { 2: '<span class="tag tag-orange">待处理</span>', 3: '<span class="tag tag-green">已处理</span>', 4: '<span class="tag tag-red">已拒绝</span>' };
  tbody.innerHTML = list.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${c.order_no}</td>
      <td>${c.product_name || '-'}</td>
      <td><code>${c.device_sn || '-'}</code></td>
      <td>${c.user_nickname || '-'}</td>
      <td>${c.plan_name} <small>¥${c.price}</small></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(c.claim_reason || '').replace(/"/g, '&quot;')}">${c.claim_reason || '-'}</td>
      <td>${c.claim_imgs && c.claim_imgs !== '[]' ? `<a href="#" onclick="viewClaimImages(${c.id});return false">查看</a>` : '无'}</td>
      <td>${c.claimed_at ? c.claimed_at.substring(0, 16) : '-'}</td>
      <td>
        <div class="btn-group">
          ${c.status === 2 ? `
            <button class="btn btn-sm btn-success" onclick="reviewClaim(${c.id}, 'approve')">确认处理</button>
            <button class="btn btn-sm btn-danger" onclick="reviewClaim(${c.id}, 'reject')">拒绝</button>
          ` : `
            <span style="color:#999;margin-right:8px">${c.status === 3 ? c.claim_result || '已处理' : c.claim_result || '已拒绝'}</span>
            <button class="btn btn-sm btn-danger" onclick="delClaim(${c.id})">删除</button>
          `}
        </div>
      </td>
    </tr>
  `).join('');

  const totalPages = Math.ceil(total / 10) || 1;
  document.getElementById('claimPagination').innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} onclick="loadClaims(${claimStatus}, ${page - 1})">上一页</button>
    <span class="current">${page} / ${totalPages}</span>
    <button ${page >= totalPages ? 'disabled' : ''} onclick="loadClaims(${claimStatus}, ${page + 1})">下一页</button>
  `;
}

function viewClaimImages(claimId) {
  const imgsJson = claimImagesCache[claimId];
  try {
    const imgs = JSON.parse(imgsJson);
    if (!imgs || imgs.length === 0) { alert('无凭证图片'); return; }
    const html = imgs.map(url => `<img src="${fileUrl(url)}" style="max-width:100%;max-height:400px;margin-bottom:12px;border-radius:4px;display:block" />`).join('');
    document.getElementById('imageViewerContent').innerHTML = html;
    document.getElementById('imageViewerModal').classList.add('show');
  } catch (e) { alert('无法查看图片'); }
}

async function reviewClaim(id, action) {
  const labels = { approve: '确认处理完成', reject: '确认拒绝报修' };
  const remark = prompt(`${labels[action]}。输入备注（可选）：`, '');
  if (remark === null) return;

  const res = await fetchApi(`/claims/${id}/review`, {
    method: 'PUT',
    body: JSON.stringify({ action, remark: remark || '' })
  });
  if (res.code === 0) { showToast(res.msg); loadClaims(claimStatus, claimPage); }
  else showToast(res.msg);
}

// ============================================================
// 管理员管理
// ============================================================
async function loadAdmins() {
  const res = await fetchApi('/admins');
  if (res.code !== 0) return;
  const admins = res.data;
  const tbody = document.getElementById('adminTable');
  const roleMap = { super_admin: '🔴 超级管理员', admin: '🟡 管理员', viewer: '🟢 查看员' };
  tbody.innerHTML = admins.map(a => `
    <tr>
      <td>${a.id}</td><td>${a.username}</td><td>${a.nickname || '-'}</td>
      <td>${roleMap[a.role] || a.role}</td>
      <td>${a.status === 1 ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-red">禁用</span>'}</td>
      <td>${(a.created_at || '').substring(0, 10)}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-sm" onclick="showAdminModal(${a.id}, '${a.username}', '${a.nickname || ''}', '${a.role}', ${a.status})">编辑</button>
          ${a.role !== 'super_admin' || a.id !== 1 ? `<button class="btn btn-sm btn-danger" onclick="delAdmin(${a.id})">删除</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function showAdminModal(editId, username, nickname, role, status) {
  document.getElementById('deviceEditId').value = editId || '';
  document.getElementById('device_product').parentElement.style.display = 'none';
  document.getElementById('device_status').parentElement.style.display = 'none';
  document.getElementById('grpDeviceSchool').style.display = 'none';
  document.getElementById('device_note').parentElement.style.display = 'none';
  // 显示管理员相关字段
  document.getElementById('device_sn').placeholder = '用户名';
  document.getElementById('device_sn').value = username || '';
  document.getElementById('device_sn').parentElement.querySelector('label').textContent = '用户名 *';
  document.getElementById('grpAdminRole').style.display = '';
  document.getElementById('adminRole').value = role || 'admin';
  document.getElementById('deviceModalTitle').textContent = editId ? '编辑管理员' : '添加管理员';
  document.getElementById('deviceModal').classList.add('show');
  window._adminEdit = { editId, role, status };
}

// 覆盖设备保存为管理员保存
const _saveDevice = saveDevice;
saveDevice = async function() {
  if (document.getElementById('deviceModalTitle').textContent.includes('管理员')) {
    return await saveAdmin();
  }
  return await _saveDevice();
};

async function saveAdmin() {
  const id = document.getElementById('deviceEditId').value;
  const username = document.getElementById('device_sn').value.trim();
  const role = document.getElementById('adminRole').value;
  if (!username) { showToast('请填写用户名'); return; }
  const body = { username, nickname: '', role };
  if (!id) {
    const pwd = prompt('设置密码：');
    if (!pwd) return;
    body.password = pwd;
    const res = await fetchApi('/admins', { method: 'POST', body: JSON.stringify(body) });
    if (res.code === 0) { showToast('添加成功'); closeModal('deviceModal'); loadAdmins(); }
    else showToast(res.msg);
  } else {
    const pwd = prompt('新密码（留空不修改）：');
    if (pwd) body.password = pwd;
    const res = await fetchApi('/admins/' + id, { method: 'PUT', body: JSON.stringify(body) });
    if (res.code === 0) { showToast('更新成功'); closeModal('deviceModal'); loadAdmins(); }
    else showToast(res.msg);
  }
}

async function delAdmin(id) {
  if (!confirm('确定删除该管理员？')) return;
  const res = await fetchApi('/admins/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadAdmins(); }
  else showToast(res.msg);
}

// ============================================================
// 设备管理
// ============================================================
// ============================================================
let devicePage = 1;

async function loadDevices(page = 1) {
  devicePage = page;
  const productId = document.getElementById('deviceProductFilter')?.value || '';
  const status = document.getElementById('deviceStatusFilter')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 10 });
  if (productId) params.set('product_id', productId);
  if (status) params.set('status', status);

  // 填充商品筛选下拉
  if (document.getElementById('deviceProductFilter').options.length <= 1) {
    const catRes = await fetchApi('/products?pageSize=100');
    if (catRes.code === 0) {
      const opts = catRes.data.list.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      document.getElementById('deviceProductFilter').innerHTML = '<option value="">全部商品</option>' + opts;
    }
  }

  const res = await fetchApi('/devices?' + params.toString());
  if (res.code !== 0) return;

  const { list, total } = res.data;
  const tbody = document.getElementById('deviceTable');
  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">暂无设备数据，请先添加设备</td></tr>';
  } else {
    const statusMap = { 1: '<span class="tag tag-green">在库</span>', 2: '<span class="tag tag-blue">已租赁</span>', 3: '<span class="tag tag-orange">维修中</span>', 4: '<span class="tag tag-gray">已报废</span>' };
    tbody.innerHTML = list.map(d => `
      <tr>
        <td>${d.id}</td>
        <td>${d.product_name || '-'}</td>
        <td><code>${d.sn}</code></td>
        <td>${d.school || '-'}</td>
        <td>${statusMap[d.status] || '-'}</td>
        <td>${d.current_order_id || '-'}</td>
        <td>${d.condition_note || '-'}</td>
        <td>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="editDevice(${d.id}, '${d.sn}', ${d.status}, '${(d.condition_note || '').replace(/'/g, "\\'")}', ${d.product_id}, '${(d.school || '').replace(/'/g, "\\'")}')">编辑</button>
            <button class="btn btn-sm" onclick="showDeviceHistory(${d.id}, '${d.sn}')">历史</button>
            ${d.status === 1 ? `<button class="btn btn-sm btn-danger" onclick="deleteDevice(${d.id})">报废</button>` : ''}
            ${d.status !== 2 ? `<button class="btn btn-sm btn-danger" onclick="removeDevice(${d.id})" style="margin-left:4px">删除</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  }
  const totalPages = Math.ceil(total / 10) || 1;
  document.getElementById('devicePagination').innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} onclick="loadDevices(${page - 1})">上一页</button>
    <span class="current">${page} / ${totalPages}</span>
    <button ${page >= totalPages ? 'disabled' : ''} onclick="loadDevices(${page + 1})">下一页</button>
  `;
}

async function showDeviceModal(editId = null) {
  // 恢复设备弹窗字段
  document.getElementById('device_product').parentElement.style.display = '';
  document.getElementById('device_status').parentElement.style.display = '';
  document.getElementById('grpDeviceSchool').style.display = '';
  document.getElementById('grpAdminRole').style.display = 'none';
  document.getElementById('device_note').parentElement.style.display = '';
  document.getElementById('device_sn').parentElement.querySelector('label').textContent = '序列号/IMEI *';
  document.getElementById('device_sn').placeholder = '设备的唯一序列号或IMEI码';

  // 加载商品选项
  const catRes = await fetchApi('/products?pageSize=100');
  const products = catRes.code === 0 ? catRes.data.list : [];
  document.getElementById('device_product').innerHTML = products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

  if (editId) {
    document.getElementById('deviceModalTitle').textContent = '编辑设备';
    document.getElementById('deviceEditId').value = editId;
  } else {
    document.getElementById('deviceModalTitle').textContent = '添加设备';
    document.getElementById('deviceEditId').value = '';
    document.getElementById('device_sn').value = '';
    document.getElementById('device_status').value = '1';
    document.getElementById('device_note').value = '';
    document.getElementById('device_school').value = '';
  }
  document.getElementById('deviceModal').classList.add('show');
}

function editDevice(id, sn, status, note, productId, school) {
  document.getElementById('deviceEditId').value = id;
  document.getElementById('device_sn').value = sn;
  document.getElementById('device_status').value = status;
  document.getElementById('device_note').value = note;
  document.getElementById('device_school').value = school || '';
  showDeviceModal(id);
  setTimeout(() => {
    if (productId) document.getElementById('device_product').value = productId;
  }, 100);
}

async function saveDevice() {
  const id = document.getElementById('deviceEditId').value;
  const data = {
    product_id: parseInt(document.getElementById('device_product').value),
    sn: document.getElementById('device_sn').value.trim(),
    condition_note: document.getElementById('device_note').value.trim(),
    school: document.getElementById('device_school').value.trim()
  };
  if (!data.product_id || !data.sn) { showToast('请选择商品并填写序列号'); return; }

  if (id) {
    data.status = parseInt(document.getElementById('device_status').value);
    const res = await fetchApi('/devices/' + id, { method: 'PUT', body: JSON.stringify(data) });
    if (res.code === 0) { showToast('更新成功'); closeModal('deviceModal'); loadDevices(devicePage); }
    else showToast(res.msg);
  } else {
    const res = await fetchApi('/devices', { method: 'POST', body: JSON.stringify(data) });
    if (res.code === 0) { showToast('添加成功'); closeModal('deviceModal'); loadDevices(devicePage); }
    else showToast(res.msg);
  }
}

async function deleteDevice(id) {
  if (!confirm('将该设备标记为报废？')) return;
  const res = await fetchApi('/devices/' + id, { method: 'PUT', body: JSON.stringify({ status: 4 }) });
  if (res.code === 0) { showToast('已报废'); loadDevices(devicePage); }
  else showToast(res.msg);
}

async function showDeviceHistory(deviceId, sn) {
  const res = await fetchApi('/devices/' + deviceId + '/history');
  if (res.code !== 0) { showToast('获取历史失败'); return; }
  const orders = res.data;
  let html = `<div><strong>设备 ${sn} 租赁历史</strong></div><div style="margin-top:12px">`;
  if (orders.length === 0) {
    html += '<div style="color:#999">暂无租赁记录</div>';
  } else {
    html += orders.map(o => `
      <div style="padding:8px 0;border-bottom:1px solid #f0f0f0">
        <div>📋 ${o.order_no} · ${o.nickname || '-'}</div>
        <div style="font-size:12px;color:#666">${o.rental_start_date} ~ ${o.rental_end_date} · ¥${o.total_rent}</div>
      </div>
    `).join('');
  }
  html += '</div>';
  // 用已有弹窗展示
  document.getElementById('depositDetail').innerHTML = html;
  document.getElementById('depositModal').classList.add('show');
  document.getElementById('depositActions').innerHTML = '<button class="btn" onclick="closeModal(\'depositModal\')">关闭</button>';
}

async function removeDevice(id) {
  if (!confirm('确定要永久删除该设备？此操作不可撤销。')) return;
  const res = await fetchApi('/devices/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadDevices(devicePage); }
  else showToast(res.msg);
}

// 改造发货函数，支持分配设备
const _changeOrderStatus = changeOrderStatus;
changeOrderStatus = async function(id, status, productId) {
  if (status === 3) {
    try {
      // 查该商品在库设备
      const devRes = await fetchApi('/devices/available/' + productId);
      if (devRes.code !== 0 || !devRes.data || !devRes.data.length) {
        alert('该商品没有在库设备！请先在「设备管理」中添加设备。');
        return;
      }

      const devices = devRes.data;
      const list = devices.map((d, i) => (i + 1) + '. ' + d.sn).join('\n');
      const choice = prompt('可选设备（在库）：\n\n' + list + '\n\n输入序号选择设备，输入 0 跳过：', '1');
      if (choice === null) return;

      const idx = parseInt(choice) - 1;
      const body = { status: 3 };
      if (idx >= 0 && idx < devices.length) {
        body.device_id = devices[idx].id;
      }

      // 输入物流信息
      const companies = ['顺丰速运', '中通快递', '圆通速递', '韵达快递', '邮政EMS', '京东物流', '极兔速递', '其他'];
      const companyList = companies.map((c, i) => (i + 1) + '. ' + c).join('\n');
      const companyChoice = prompt('选择快递公司：\n\n' + companyList + '\n\n输入序号（可取消跳过）：', '1');
      if (companyChoice !== null) {
        const ci = parseInt(companyChoice) - 1;
        if (ci >= 0 && ci < companies.length) {
          body.tracking_company = companies[ci];
          const trackingNo = prompt('输入快递单号（可取消跳过）：');
          if (trackingNo && trackingNo.trim()) {
            body.tracking_no = trackingNo.trim();
          }
        }
      }

      const res = await fetchApi('/orders/' + id + '/status', {
        method: 'PUT', body: JSON.stringify(body)
      });
      if (res.code === 0) { showToast(res.msg); loadOrders(orderPage); loadStats(); }
      else showToast(res.msg);
    } catch (err) {
      showToast('操作失败');
    }
  } else {
    _changeOrderStatus(id, status);
  }
};

// ============================================================
// 后补分配设备
async function assignDevice(orderId, productId) {
  try {
    const devRes = await fetchApi('/devices/available/' + productId);
    if (devRes.code !== 0 || !devRes.data || !devRes.data.length) {
      alert('该商品没有在库设备！');
      return;
    }

    const devices = devRes.data;
    const list = devices.map((d, i) => (i + 1) + '. ' + d.sn).join('\n');
    const choice = prompt('可选设备（在库）：\n\n' + list + '\n\n输入序号选择设备：', '1');
    if (choice === null) return;

    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= devices.length) { showToast('无效选择'); return; }

    const res = await fetchApi('/orders/' + orderId + '/assign-device', {
      method: 'PUT', body: JSON.stringify({ device_id: devices[idx].id })
    });
    if (res.code === 0) { showToast(res.msg); loadOrders(orderPage); }
    else showToast(res.msg);
  } catch (err) { showToast('操作失败'); }
}

// ============================================================
// 删除操作
// ============================================================
async function delVerification(id) {
  if (!confirm('确定删除该认证记录？')) return;
  const res = await fetchApi('/verifications/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadVerifications(verifStatus, verifPage); }
  else showToast(res.msg);
}
async function delDeposit(id) {
  if (!confirm('确定删除该押金审核记录？')) return;
  const res = await fetchApi('/deposit-orders/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadDeposits(depositStatus, depositPage); }
  else showToast(res.msg);
}
async function delClaim(id) {
  if (!confirm('确定删除该报修记录？')) return;
  const res = await fetchApi('/claims/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadClaims(claimStatus, claimPage); }
  else showToast(res.msg);
}
async function delOrder(id) {
  if (!confirm('确定永久删除该订单？此操作不可撤销。')) return;
  const res = await fetchApi('/orders/' + id, { method: 'DELETE' });
  if (res.code === 0) { showToast('已删除'); loadOrders(orderPage); loadStats(); }
  else showToast(res.msg);
}

function getFirstImage(images) {
  try {
    if (!images) return null;
    if (images.startsWith('[')) {
      const arr = JSON.parse(images);
      return arr.length > 0 ? arr[0] : null;
    }
    return images.split(',')[0].trim();
  } catch (e) { return null; }
}

function maskIdCard(idCard) {
  if (!idCard || idCard.length < 8) return idCard;
  return idCard.substring(0, 4) + '**********' + idCard.substring(idCard.length - 4);
}

// 标签函数
// ============================================================
function statusTag(status) {
  const map = { 1: '<span class="tag tag-orange">审核中</span>', 2: '<span class="tag tag-green">已通过</span>', 3: '<span class="tag tag-red">已拒绝</span>' };
  return map[status] || '<span class="tag tag-gray">未知</span>';
}

function orderStatusTag(status) {
  const map = {
    0: '<span class="tag tag-gray">已取消</span>',
    1: '<span class="tag tag-orange">待审核押金</span>',
    2: '<span class="tag tag-blue">待付款</span>',
    3: '<span class="tag tag-blue">待发货</span>',
    4: '<span class="tag tag-green">租赁中</span>',
    5: '<span class="tag tag-green">已完成</span>',
    6: '<span class="tag tag-orange">待归还验收</span>'
  };
  return map[status] || '<span class="tag tag-gray">未知</span>';
}
