try { require('dotenv').config(); } catch (e) { /* 云托管环境变量已注入，dotenv 16- 使用 require，17+ 为 ESM 不可用 */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// 读取配置（优先级：环境变量 > 兜底默认值）
// ⚠️ 安全提醒：以下默认值应与 cloudbaserc.json → envParams 保持一致
//    生产环境应将 CloudBase 密钥轮换为专用密钥
const CLOUD_ENV = process.env.CLOUD_ENV || 'cloud1-d0gtbh90x8d74a386';
const CLOUD_SECRET_ID = process.env.CLOUD_SECRET_ID || '';
const CLOUD_SECRET_KEY = process.env.CLOUD_SECRET_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!CLOUD_SECRET_ID || !CLOUD_SECRET_KEY) {
  console.error('\n⚠️  CloudBase 密钥未配置，API 调用将失败\n');
}
// 云函数内部调用认证密钥（Express ↔ 云函数之间的共享密钥）
// 未显式设置时从 CLOUD_SECRET_ID 派生，防止云函数被外部直接调用
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ||
  crypto.createHash('sha256').update(CLOUD_SECRET_ID + '_yijiquan_admin').digest('hex').substring(0, 16);

// 分校管理员配置：school1:pwd1;school2:pwd2
const BRANCH_ADMINS_STR = process.env.BRANCH_ADMINS || '';
var BRANCH_PASSWORDS = {}; // { password: school_name }
BRANCH_ADMINS_STR.split(';').forEach(function(s) {
  var parts = s.split(':');
  if (parts.length === 2) BRANCH_PASSWORDS[parts[1].trim()] = parts[0].trim();
});
const sessions = new Map(); // token → { time, role, school }
const smsCodes = new Map(); // phone → { code, expires, attempts }
const loginFailures = new Map(); // key → { count, lockUntil } — 防暴力破解
let autoExportConfig = { enabled: true, export_path: 'D:\\weixin\\csv' }; // 自动导出配置
let isExporting = false; // 自动导出执行锁

const cloudbase = require('@cloudbase/node-sdk');
const helmet = require('helmet');
const app = express();

// 安全 HTTP 头
app.use(helmet({
  contentSecurityPolicy: false,  // CSP 由前端 index.html 的 <meta> 标签控制
  crossOriginEmbedderPolicy: false
}));

// CORS — 允许 GitHub Pages 等外部域名跨域访问 API
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://danielyjq678-glitch.github.io,http://localhost:3000').split(',').map(function(s) { return s.trim(); });
app.use(function(req, res, next) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// ====== 物理删除接口（在 express.static 之前注册，无权限校验，纯 JSON 输出） ======

// 整机售卖商品删除 — POST /api/sales-products/delete
app.post('/api/sales-products/delete', async (req, res) => {
  try {
    const { id } = req.body;
    console.log('[delete] sales-products id:', id);
    if (!id) {
      return res.status(400).json({ code: 400, error: '缺少商品ID', msg: '缺少商品ID' });
    }
    const removeRes = await db.collection('sales_products').doc(id).remove();
    console.log('[delete] sales-products result:', JSON.stringify(removeRes));
    return res.status(200).json({ code: 200, error: null, msg: '删除成功' });
  } catch (e) {
    console.error('[delete] sales-products error:', e.message);
    return res.status(500).json({ code: 500, error: '删除失败: ' + e.message, msg: '删除失败: ' + e.message });
  }
});

// 数码配件删除 — POST /api/accessories/delete
app.post('/api/accessories/delete', async (req, res) => {
  try {
    const { id } = req.body;
    console.log('[delete] accessories id:', id);
    if (!id) {
      return res.status(400).json({ code: 400, error: '缺少配件ID', msg: '缺少配件ID' });
    }
    const removeRes = await db.collection('accessories').doc(id).remove();
    console.log('[delete] accessories result:', JSON.stringify(removeRes));
    return res.status(200).json({ code: 200, error: null, msg: '删除成功' });
  } catch (e) {
    console.error('[delete] accessories error:', e.message);
    return res.status(500).json({ code: 500, error: '删除失败: ' + e.message, msg: '删除失败: ' + e.message });
  }
});

// 设备删除 — POST /api/devices/delete（物理删除，不联动订单/租赁数据）
app.post('/api/devices/delete', async (req, res) => {
  try {
    const { id } = req.body;
    console.log('[delete] devices id:', id);
    if (!id) {
      return res.status(400).json({ code: 400, error: '缺少设备ID', msg: '缺少设备ID' });
    }
    // ★ 删除前查询设备信息（用于同步 products.stock）
    var deletedProductId = '';
    var wasAvailable = false;
    try {
      var delDevDoc = await db.collection('devices').doc(id).get();
      var delDev = Array.isArray(delDevDoc.data) ? delDevDoc.data[0] : delDevDoc.data;
      if (delDev) {
        deletedProductId = (delDev.product_id || '').trim();
        wasAvailable = (delDev.status === '在库' || delDev.status === 'available');
      }
    } catch (eDev) {
      console.warn('[delete] 查询待删除设备失败:', eDev.message);
    }
    const removeRes = await db.collection('devices').doc(id).remove();
    console.log('[delete] devices result:', JSON.stringify(removeRes));
    // ★ 同步扣减 products.stock（仅当设备为「在库」时）
    if (deletedProductId && wasAvailable) {
      try {
        await db.collection('products').doc(deletedProductId).update({
          data: { stock: _.inc(-1), updated_at: new Date() }
        });
        console.log('[delete] products.stock -1 for productId=' + deletedProductId);
      } catch (eStock) {
        console.warn('[delete] products.stock 扣减失败（非阻塞）:', eStock.message);
      }
    }
    return res.status(200).json({ code: 200, error: null, msg: '删除成功' });
  } catch (e) {
    console.error('[delete] devices error:', e.message);
    return res.status(500).json({ code: 500, error: '删除失败: ' + e.message, msg: '删除失败: ' + e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public')));

// 文件上传（临时存储，上传云端后删除）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// 初始化 CloudBase（管理员权限）
const tcb = cloudbase.init({
  env: CLOUD_ENV,
  secretId: CLOUD_SECRET_ID,
  secretKey: CLOUD_SECRET_KEY
});
const db = tcb.database();
const _ = db.command;

// ═══════════════════════════════════════════════════════════════
// 学校名称归一化 — 兼容全称/简称/缩写匹配
// ═══════════════════════════════════════════════════════════════
const SCHOOL_ALIAS_MAP = {
  // key 为标准化名称，value 为别名数组
  '广东工业大学': ['广工', '广东工业'],
  '广东工业':   ['广工', '广东工业大学'],
  '广工':       ['广东工业大学', '广东工业'],
};
function normalizeSchool(name) {
  if (!name) return '';
  return String(name).trim().replace(/\s+/g, '');
}
function isSameSchool(a, b) {
  var na = normalizeSchool(a);
  var nb = normalizeSchool(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // 双向查询别名映射
  var aliasesA = SCHOOL_ALIAS_MAP[na] || [];
  var aliasesB = SCHOOL_ALIAS_MAP[nb] || [];
  return aliasesA.indexOf(nb) !== -1 || aliasesB.indexOf(na) !== -1;
}

// ==================== 微信支付退款（调用云函数） ====================

/**
 * 通过 refundOrder 云函数执行微信支付原路退款
 * 退款凭证与 wxpayOrder 云函数共用，确保环境一致
 * @returns {{ success: boolean, refund_id?: string, error?: string }}
 */
async function refundWechatPay(order, refundAmountYuan, outRefundNo) {
  if (!order.order_no) {
    return { success: false, error: '订单缺少 order_no，无法发起微信退款' };
  }

  var totalRent = parseFloat(order.total_rent || 0);
  var refundAmountCents = Math.round(parseFloat(refundAmountYuan) * 100);
  var totalCents = Math.round(totalRent * 100);

  if (totalCents <= 0) {
    return { success: false, error: '订单总金额异常（total_rent=' + order.total_rent + '），无法计算退款' };
  }
  if (refundAmountCents > totalCents) {
    return { success: false, error: '退款金额(' + refundAmountYuan + '元)超过订单实付金额(' + totalRent + '元)' };
  }

  console.log('[refund] 调用 refundOrder 云函数 out_trade_no=' + order.order_no + ' refund=' + refundAmountCents + '分');

  try {
    var refundRes = await tcb.callFunction({
      name: 'refundOrder',
      data: {
        out_trade_no: order.order_no,
        out_refund_no: outRefundNo,
        reason: '订单退款',
        refund_amount: refundAmountCents,
        total_amount: totalCents
      }
    });

    var result = refundRes.result || {};
    if (result.code === 0) {
      console.log('[refund] 退款成功 refund_id=' + (result.data && result.data.refund_id));
      return { success: true, refund_id: result.data && result.data.refund_id };
    } else {
      // 直接透传云函数返回的具体错误（凭证缺失、余额不足、参数错误等）
      console.error('[refund] 云函数返回失败:', result.msg);
      return { success: false, error: result.msg || '退款云函数返回未知错误' };
    }
  } catch (e) {
    console.error('[refund] 调用 refundOrder 云函数异常:', e.message);
    return { success: false, error: '调用退款云函数失败: ' + e.message };
  }
}

// ==================== 通知辅助 ====================
async function notifyUser(orderId, type, extra) {
  try {
    await tcb.callFunction({
      name: 'sendOrderNotify',
      data: { orderId, type, extra }
    });
  } catch (e) {
    console.error('[notify] 调用云函数失败:', e.message);
  }
}

// ==================== 学校名称→ID 映射（兼容老数据） ====================
var schoolNameToIdMap = {};
var schoolIdToInfoMap = {}; // schoolId → { schoolName, branchName, ... }

async function loadBranchMap() {
  try {
    var { data: branches } = await db.collection('branches').where({ status: 'active' }).get();
    branches = Array.isArray(branches) ? branches : [];
    schoolNameToIdMap = {};
    schoolIdToInfoMap = {};
    branches.forEach(function(b) {
      schoolNameToIdMap[b.schoolName] = b.schoolId;
      if (b.shortName) schoolNameToIdMap[b.shortName] = b.schoolId;
      if (b.branchName && b.branchName !== b.schoolName) schoolNameToIdMap[b.branchName] = b.schoolId;
      schoolIdToInfoMap[b.schoolId] = {
        schoolName: b.schoolName,
        branchName: b.branchName || b.schoolName,
        shortName: b.shortName || b.schoolName
      };
    });
  } catch (e) { /* 集合可能还不存在 */ }
}

function resolveBranchId(schoolName) {
  if (!schoolName) return '';
  if (schoolNameToIdMap[schoolName]) return schoolNameToIdMap[schoolName];
  for (var key in schoolNameToIdMap) {
    if (key.indexOf(schoolName) >= 0 || schoolName.indexOf(key) >= 0) {
      return schoolNameToIdMap[key];
    }
  }
  return '';
}

function getBranchInfo(branchId) {
  return schoolIdToInfoMap[branchId] || null;
}

// 身份证号脱敏
function maskIdCard(id) {
  if (!id || typeof id !== 'string' || id.length < 8) return id || '';
  var masked = '';
  for (var i = 3; i < id.length - 4; i++) masked += '*';
  return id.substring(0, 3) + masked + id.substring(id.length - 4);
}

// 分点管理员订单归属校验——仅总号可跨分点操作
function canAccessOrder(req, order) {
  if (req.adminRole === 'super') return true;
  var adminBranchId = req.adminBranchId || '';
  var orderBranchId = order.schoolId || order.branchId || '';
  if (adminBranchId && orderBranchId && adminBranchId === orderBranchId) return true;
  // 兼容旧数据：order_source 匹配
  if (req.adminSchool && order.order_source && req.adminSchool === order.order_source) return true;
  return false;
}

// ==================== 认证中间件 ====================
function authRequired(req, res, next) {
  const token = req.headers['x-auth-token'];
  var session = sessions.get(token);
  if (!token || !session) {
    return res.status(401).json({ error: '未登录' });
  }
  // 每次鉴权时清理所有过期 session
  var now = Date.now();
  for (const [k, v] of sessions) { if (now - v.time > 86400000) sessions.delete(k); }
  session.time = now;
  req.adminRole = session.role || 'super';
  req.adminSchool = session.school || '';
  req.adminBranchId = session.branchId || resolveBranchId(session.school || '');
  next();
}

// 健康检查（不依赖任何配置）
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: CLOUD_ENV,
    hasSecret: !!(CLOUD_SECRET_ID && CLOUD_SECRET_KEY),
    tcbReady: !!(CLOUD_SECRET_ID && CLOUD_SECRET_KEY),
    time: new Date().toISOString()
  });
});

// 获取当前管理员信息
app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ role: req.adminRole, school: req.adminSchool, branchId: req.adminBranchId || '' });
});

function hideError(res, e) {
  console.error('[Admin]', e.message, e.stack || '');
  res.status(500).json({ error: '内部服务器错误' });
}

// 登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { password } = req.body;

    // 防暴力破解：IP 级别限速（5次失败/15分钟）
    var ip = req.ip || req.connection.remoteAddress || 'unknown';
    var fbKey = 'pwd_' + ip;
    var fb = loginFailures.get(fbKey);
    if (fb && fb.lockUntil > Date.now()) {
      return res.status(429).json({ error: '尝试次数过多，请15分钟后再试' });
    }

    var role = 'super';
    var school = '';
    var branchId = '';
    if (password === ADMIN_PASSWORD) {
      role = 'super';
    } else if (BRANCH_PASSWORDS[password]) {
      role = 'branch';
      school = BRANCH_PASSWORDS[password];
      branchId = resolveBranchId(school);
    } else {
      // 查询数据库 branch_admins 表（明文密码）
      var { data: dbAdmins } = await db.collection('branch_admins').where({ status: 1 }).get();
      var dbList = Array.isArray(dbAdmins) ? dbAdmins : [];
      var matched = null;
      for (var admin of dbList) {
        if (admin.password && password === admin.password) {
          matched = admin; break;
        }
      }
      if (matched) {
        role = 'branch';
        school = matched.school;
        branchId = matched.branchId || resolveBranchId(school);
      } else {
        // 记录登录失败
        var fails = loginFailures.get(fbKey) || { count: 0, lockUntil: 0 };
        fails.count++;
        if (fails.count >= 5) {
          fails.lockUntil = Date.now() + 15 * 60 * 1000;
          return res.status(429).json({ error: '尝试次数过多，请15分钟后再试' });
        }
        loginFailures.set(fbKey, fails);
        return res.status(401).json({ error: '密码错误' });
      }
    }
    // 登录成功 → 清除失败计数
    loginFailures.delete(fbKey);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { time: Date.now(), role: role, school: school, branchId: branchId });
    const now = Date.now();
    for (const [k, v] of sessions) { if (now - v.time > 86400000) sessions.delete(k); }
    res.json({ token, role: role, school: school, branchId: branchId });
  } catch (e) { hideError(res, e); }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ msg: '已退出' });
});

// ==================== 短信验证码登录 ====================

// 发送短信验证码
app.post('/api/auth/send-sms', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: '请输入有效的手机号码' });
    }

    // 检查手机号是否已绑定管理员
    var { data: phones } = await db.collection('admin_phones').where({ phone, status: 1 }).get();
    var phoneList = Array.isArray(phones) ? phones : [];
    if (phoneList.length === 0) {
      return res.status(400).json({ error: '该手机号未绑定管理员账号' });
    }

    // 60 秒内不可重复发送
    var existing = smsCodes.get(phone);
    if (existing && Date.now() - existing.time < 60000) {
      return res.status(400).json({ error: '请60秒后再试' });
    }

    // 生成 6 位验证码
    var code = String(Math.floor(100000 + Math.random() * 900000));

    // 存储验证码（5 分钟有效期）
    smsCodes.set(phone, { code, time: Date.now(), attempts: 0 });

    // 尝试通过云函数发送短信
    var sent = false;
    try {
      var cfResult = await tcb.callFunction({
        name: 'sendSmsCode',
        data: { phone, code }
      });
      var cfData = (cfResult && cfResult.result) || {};
      sent = cfData.sent === true;
      if (!sent) {
        console.log('[SMS] 云函数未发送真实短信（devMode=' + (cfData.devMode ? 'true' : 'false') + '）');
      }
    } catch (e) {
      console.log('[SMS] 云函数调用失败，服务端降级:', e.message);
    }

    // 生产环境：短信发送失败时明确报错，不返回验证码明文
    if (sent) {
      res.json({ msg: '验证码已发送' });
    } else {
      // 云函数降级/devMode：仅响应 msg，不返回 devCode 到客户端
      res.json({ msg: '验证码已生成' });
    }
  } catch (e) { hideError(res, e); }
});

// 手机号验证码登录
app.post('/api/auth/login-sms', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: '请输入手机号和验证码' });

    // 检查暴力破解
    var fbKey = 'sms_' + phone;
    var fb = loginFailures.get(fbKey);
    if (fb && fb.lockUntil > Date.now()) {
      return res.status(429).json({ error: '尝试次数过多，请15分钟后再试' });
    }

    // 校验验证码
    var record = smsCodes.get(phone);
    if (!record) return res.status(400).json({ error: '请先获取验证码' });
    if (Date.now() - record.time > 300000) {
      smsCodes.delete(phone);
      return res.status(400).json({ error: '验证码已过期，请重新获取' });
    }

    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) {
      smsCodes.delete(phone);
      return res.status(400).json({ error: '验证码错误次数过多，请重新获取' });
    }

    if (record.code !== String(code)) {
      smsCodes.set(phone, record);
      return res.status(400).json({ error: '验证码错误' });
    }

    // 验证通过，删除验证码
    smsCodes.delete(phone);
    loginFailures.delete(fbKey);

    // 查找绑定该手机号的管理员
    var { data: phones } = await db.collection('admin_phones').where({ phone, status: 1 }).get();
    var phoneList = Array.isArray(phones) ? phones : [];
    if (phoneList.length === 0) {
      return res.status(400).json({ error: '该手机号未绑定管理员账号' });
    }

    var adminPhone = phoneList[0];
    var role = adminPhone.role || 'branch';
    var school = adminPhone.school || '';
    var branchId = adminPhone.branchId || resolveBranchId(school);

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { time: Date.now(), role, school, branchId });
    res.json({ token, role, school, branchId });
  } catch (e) { hideError(res, e); }
});

// ==================== 管理员手机号管理（仅主管理员） ====================

// 列表
app.get('/api/admin-phones', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var list;
    try {
      var result = await db.collection('admin_phones').where({ status: _.gte(0) }).orderBy('created_at', 'desc').get();
      list = Array.isArray(result.data) ? result.data : [];
    } catch (e) {
      // created_at 字段可能不存在于旧记录，降级为无排序查询
      var result = await db.collection('admin_phones').where({ status: _.gte(0) }).get();
      list = Array.isArray(result.data) ? result.data : [];
    }
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// 保存（新增/编辑）
app.post('/api/admin-phones/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { phoneId, phone, school, role } = req.body;
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: '请输入有效的手机号码' });
    }
    if (!school) return res.status(400).json({ error: '请填写所属学校' });

    // 检查手机号是否已被其他记录绑定
    var { data: existing } = await db.collection('admin_phones').where({ phone, status: 1 }).get();
    var exList = Array.isArray(existing) ? existing : [];
    if (exList.length > 0 && (!phoneId || exList[0]._id !== phoneId)) {
      return res.status(400).json({ error: '该手机号已被其他管理员绑定' });
    }

    var data = { phone, school, role: role || 'branch', updated_at: new Date() };
    if (phoneId) {
      await db.collection('admin_phones').doc(phoneId).update(data);
    } else {
      data.status = 1;
      data.created_at = new Date();
      await db.collection('admin_phones').add(data);
    }
    res.json({ msg: phoneId ? '已更新' : '已添加' });
  } catch (e) { hideError(res, e); }
});

// 删除（软删除）
app.post('/api/admin-phones/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { phoneId } = req.body;
    if (!phoneId) return res.status(400).json({ error: '缺少记录ID' });
    await db.collection('admin_phones').doc(phoneId).update({ status: 0, updated_at: new Date() });
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// ==================== API 路由 ====================

// 仪表盘统计
app.get('/api/stats', authRequired, async (req, res) => {
  try {
    const [usersRes, ordersRes, productsRes, verificationsRes] = await Promise.all([
      db.collection('users').count(),
      db.collection('orders').count(),
      db.collection('products').count(),
      db.collection('verifications').where({ status: 1 }).count()
    ]);

    // 总营收：仅统计已完成的订单（status=5）
    const { data: completedOrders } = await db.collection('orders')
      .where({ status: 5 }).get();

    let totalRevenue = 0;
    for (const order of completedOrders) {
      totalRevenue += parseFloat(order.total_rent || 0);
      // 加上保险费用
      try {
        const { data: insurances } = await db.collection('order_insurances')
          .where({ order_id: order._id }).get();
        var insList = Array.isArray(insurances) ? insurances : [];
        for (var ins of insList) {
          totalRevenue += parseFloat(ins.price || 0);
        }
      } catch (e) { /* 忽略 */ }
      // 加上损坏扣款
      totalRevenue += parseFloat(order.damage_fee || 0);
      // 减去逾期费（逾期费是惩罚，也可计入营收，这里算进去）
      totalRevenue += parseFloat(order.overdue_fee || 0);
    }

    // 今日订单数（今天创建的订单）
    const today = new Date().toISOString().slice(0, 10);
    var todayOrders = 0;
    for (const order of completedOrders) {
      const created = order.created_at ? new Date(order.created_at).toISOString().slice(0, 10) : '';
      if (created === today) todayOrders++;
    }

    res.json({
      userCount: usersRes.total, orderCount: ordersRes.total,
      productCount: productsRes.total, pendingVerifications: verificationsRes.total,
      completedCount: completedOrders.length,
      totalRevenue: totalRevenue.toFixed(2), todayOrders
    });
  } catch (e) { hideError(res, e); }
});

// 待审核列表
app.get('/api/verifications', authRequired, async (req, res) => {
  try {
    const { data: list } = await db.collection('verifications')
      .where({ status: 1 }).orderBy('created_at', 'desc').get();
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// 审核通过
app.post('/api/verifications/approve', authRequired, async (req, res) => {
  try {
    const { verificationId } = req.body;
    if (!verificationId) return res.status(400).json({ error: '缺少认证ID' });

    const doc = await db.collection('verifications').doc(verificationId).get();
    var vers = null;
    if (Array.isArray(doc.data)) {
      vers = doc.data.length > 0 ? doc.data[0] : null;
    } else if (doc.data && typeof doc.data === 'object') {
      vers = doc.data;
    }
    if (!vers) return res.status(400).json({ error: '认证记录不存在' });
    if (Number(vers.status) !== 1) return res.status(400).json({ error: '该认证已处理，请刷新列表' });

    var userOpenid = vers._openid;
    var userId = vers.user_id;  // 新版认证记录带有 user_id，可直接 doc(userId) 更新
    var depositDiscount = vers.auth_type === 1 ? 1 : 0.3;

    // 更新认证记录状态
    await db.collection('verifications').doc(verificationId).update({
      status: 2, reviewed_at: new Date()
    });

    // 更新用户认证状态
    var userUpdated = false;

    // 优先用 user_id 直接更新（最可靠，不走 _openid 查询）
    if (userId) {
      try {
        await db.collection('users').doc(userId).update({
          auth_status: 2,
          auth_type: vers.auth_type || 1,
          deposit_discount: depositDiscount,
          updated_at: new Date()
        });
        userUpdated = true;
      } catch (e2) {
        console.error('[approve] doc(userId) 更新失败，尝试 _openid 方式: userId=' + userId, e2.message);
      }
    }

    // 回退：通过 _openid 查找（兼容旧认证记录没有 user_id 的情况）
    if (!userUpdated && userOpenid) {
      try {
        var userDoc = await db.collection('users').where({ _openid: userOpenid }).get();
        var userList = [];
        if (Array.isArray(userDoc.data)) {
          userList = userDoc.data;
        } else if (userDoc.data && typeof userDoc.data === 'object') {
          userList = [userDoc.data];
        }
        if (userList.length > 0) {
          await db.collection('users').doc(userList[0]._id).update({
            auth_status: 2,
            auth_type: vers.auth_type || 1,
            deposit_discount: depositDiscount,
            updated_at: new Date()
          });
          userUpdated = true;
        } else {
          await db.collection('users').add({
            _openid: userOpenid,
            nickname: '',
            gender: 0,
            phone: '',
            auth_status: 2,
            auth_type: vers.auth_type || 1,
            deposit_discount: depositDiscount,
            points: 0,
            exp: 0,
            created_at: new Date(),
            updated_at: new Date()
          });
          userUpdated = true;
        }
      } catch (e2) {
        console.error('[approve] 更新用户失败: _openid=' + userOpenid, e2.message);
      }
    }

    if (!userUpdated) {
      console.error('[approve] 用户更新完全失败: verificationId=' + verificationId + ', userId=' + userId + ', _openid=' + userOpenid);
    }

    res.json({ msg: '认证已通过' + (userUpdated ? '' : '（用户状态更新失败！请联系开发者检查服务器日志）') });
  } catch (e) { hideError(res, e); }
});

// 删除认证记录
app.post('/api/verifications/delete', authRequired, async (req, res) => {
  try {
    const { verificationId } = req.body;
    await db.collection('verifications').doc(verificationId).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// 审核拒绝
app.post('/api/verifications/reject', authRequired, async (req, res) => {
  try {
    const { verificationId, reason } = req.body;
    if (!verificationId) return res.status(400).json({ error: '缺少认证ID' });

    const doc = await db.collection('verifications').doc(verificationId).get();
    var vers = null;
    if (Array.isArray(doc.data)) {
      vers = doc.data.length > 0 ? doc.data[0] : null;
    } else if (doc.data && typeof doc.data === 'object') {
      vers = doc.data;
    }
    if (!vers) return res.status(400).json({ error: '认证记录不存在' });
    if (Number(vers.status) !== 1) return res.status(400).json({ error: '该认证已处理，请刷新列表' });

    var userOpenid = vers._openid;
    var userId = vers.user_id;

    // 更新认证记录状态
    await db.collection('verifications').doc(verificationId).update({
      status: 3, reject_reason: reason || '信息不符', reviewed_at: new Date()
    });

    // 更新用户认证状态
    var userUpdated = false;

    if (userId) {
      try {
        await db.collection('users').doc(userId).update({
          auth_status: 3, updated_at: new Date()
        });
        userUpdated = true;
      } catch (e2) {
        console.error('[reject] doc(userId) 更新失败: userId=' + userId, e2.message);
      }
    }

    if (!userUpdated && userOpenid) {
      try {
        var userDoc = await db.collection('users').where({ _openid: userOpenid }).get();
        var userList = [];
        if (Array.isArray(userDoc.data)) {
          userList = userDoc.data;
        } else if (userDoc.data && typeof userDoc.data === 'object') {
          userList = [userDoc.data];
        }
        if (userList.length > 0) {
          await db.collection('users').doc(userList[0]._id).update({
            auth_status: 3, updated_at: new Date()
          });
          userUpdated = true;
        } else {
          await db.collection('users').add({
            _openid: userOpenid,
            nickname: '',
            gender: 0,
            phone: '',
            auth_status: 3,
            points: 0,
            exp: 0,
            created_at: new Date(),
            updated_at: new Date()
          });
          userUpdated = true;
        }
      } catch (e2) {
        console.error('[reject] 更新用户失败: _openid=' + userOpenid, e2.message);
      }
    }

    if (!userUpdated) {
      console.error('[reject] 用户更新完全失败: verificationId=' + verificationId);
    }
    res.json({ msg: '认证已拒绝' + (userUpdated ? '' : '（用户状态更新失败！请联系开发者检查服务器日志）') });
  } catch (e) { hideError(res, e); }
});

// 订单列表（支持学校/分点筛选 + 状态筛选 + 分校权限控制）
app.get('/api/orders', authRequired, async (req, res) => {
  try {
    const { status, source, schoolId, branchId, orderStatus, paymentStatus,
            depositStatus, deviceStatus, transferStatus, abnormalTag,
            orderId, _id,
            page = 1, pageSize = 20 } = req.query;
    let where = {};
    let conditions = [];

    // 按订单 ID 精确查询（发货弹窗等场景复用此接口）
    if (orderId || _id) {
      where._id = orderId || _id;
      var { data: singleList } = await db.collection('orders').where(where).limit(1).get();
      singleList = Array.isArray(singleList) ? singleList : [];
      return res.json({ list: singleList, total: singleList.length, page: 1, pageSize: 1 });
    }

    // 分校管理员：通过 branchId 过滤（优先），回退到文字匹配
    if (req.adminRole === 'branch') {
      if (req.adminBranchId) {
        conditions.push(_.or([
          { schoolId: req.adminBranchId },
          { branchId: req.adminBranchId },
          { order_source: req.adminSchool }  // 兼容老数据
        ]));
      } else if (req.adminSchool) {
        conditions.push(_.or([
          { order_source: req.adminSchool },
          { schoolName: req.adminSchool }
        ]));
      }
    }

    // 学校筛选（仅超级管理员可用）
    if (req.adminRole === 'super') {
      if (schoolId) {
        conditions.push(_.or([
          { schoolId: schoolId },
          { order_source: resolveBranchId(schoolId) ? schoolId : undefined }
        ].filter(Boolean)));
      }
      if (branchId) {
        conditions.push(_.or([
          { branchId: branchId },
          { fulfillmentBranchId: branchId }
        ]));
      }
      if (source) {
        if (source === '__other__') {
          var knownIds = Object.keys(schoolNameToIdMap);
          if (knownIds.length > 0) {
            conditions.push(_.or([
              { schoolId: _.nin(knownIds) },
              { schoolId: 'UNKNOWN' },
              { schoolId: _.exists(false) }
            ]));
          }
        } else {
          conditions.push(_.or([
            { order_source: source },
            { schoolName: source }
          ]));
        }
      }
    }

    // 新状态字段筛选
    if (orderStatus) conditions.push({ orderStatus: orderStatus });
    if (paymentStatus) conditions.push({ paymentStatus: paymentStatus });
    if (depositStatus) conditions.push({ depositStatus: Number(depositStatus) });
    if (deviceStatus) conditions.push({ deviceStatus: deviceStatus });
    if (transferStatus) conditions.push({ transferStatus: transferStatus });
    if (abnormalTag) conditions.push({ abnormalTags: _.in([abnormalTag]) });

    // 兼容旧 status 筛选
    if (status && !orderStatus) conditions.push({ status: Number(status) });

    if (conditions.length > 0) where = _.and(conditions);

    const { data: list } = await db.collection('orders').where(where)
      .skip((page - 1) * pageSize).limit(Number(pageSize))
      .orderBy('created_at', 'desc').get();
    const { total } = await db.collection('orders').where(where).count();
    res.json({ list, total, page: Number(page), pageSize: Number(pageSize),
      role: req.adminRole, school: req.adminSchool, branchId: req.adminBranchId || '' });
  } catch (e) { hideError(res, e); }
});

// 押金审核（通过：设定最终押金 → 状态变为待付款；拒绝：标记拒绝原因）
app.post('/api/orders/deposit-review', authRequired, async (req, res) => {
  try {
    const { orderId, action, finalDeposit, rejectReason } = req.body;
    if (!orderId || !action) return res.status(400).json({ error: '缺少参数' });

    const doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });
    // 兼容新旧状态：旧 status===1（待审核押金）或新 orderStatus==='pending'
    var canReview = Number(order.status) === 1 || order.orderStatus === 'pending';
    if (!canReview) return res.status(400).json({ error: '该订单不在待审核押金状态' });

    if (action === 'approve') {
      var deposit = parseFloat(finalDeposit);
      if (isNaN(deposit) || deposit < 0) return res.status(400).json({ error: '请输入有效的押金金额' });
      await db.collection('orders').doc(orderId).update({
        final_deposit: deposit,
        deposit_status: 2, depositStatus: 'deposit_paid',
        status: 2, orderStatus: 'waiting_delivery',
        deposit_reviewed_at: new Date(),
        updated_at: new Date()
      });
      notifyUser(orderId, 'deposit_approved');
      res.json({ msg: '押金审核通过，订单已进入待付款状态' });
    } else if (action === 'reject') {
      await db.collection('orders').doc(orderId).update({
        deposit_status: 3, depositStatus: 'abnormal',
        status: 0, orderStatus: 'cancelled',
        deposit_reject_reason: rejectReason || '信息不符',
        deposit_reviewed_at: new Date(),
        updated_at: new Date()
      });
      notifyUser(orderId, 'deposit_rejected', { reason: rejectReason || '信息不符' });
      res.json({ msg: '押金审核已拒绝' });
    } else {
      res.status(400).json({ error: '无效操作' });
    }
  } catch (e) { hideError(res, e); }
});

// 归还验收
app.post('/api/orders/return-verify', authRequired, async (req, res) => {
  try {
    const { orderId, action, damageFee, damageNote } = req.body;
    if (!orderId || !action) return res.status(400).json({ error: '缺少参数' });

    const doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });
    // 兼容新旧状态：旧 status===6（待归还验收）或新 orderStatus==='waiting_return'
    var canVerify = Number(order.status) === 6 || order.orderStatus === 'waiting_return';
    if (!canVerify) return res.status(400).json({ error: '该订单不在待归还验收状态' });

    if (action === 'complete') {
      // 保存验收前订单状态，用于设备释放失败时回滚
      var prevStatus = order.status;
      var prevOrderStatus = order.orderStatus || '';
      var prevDeviceStatus = order.deviceStatus || '';
      var prevDeviceSn = order.device_sn || '';
      var prevDeviceId = order.device_id || order.deviceId || '';
      var prevReturnedAt = order.returned_at || null;

      var updateData = {
        status: 5,
        orderStatus: 'completed',
        deviceStatus: 'returned',
        returned_at: new Date(),
        updated_at: new Date()
      };
      var fee = parseFloat(damageFee);
      if (!isNaN(fee) && fee > 0) {
        updateData.damage_fee = fee;
        updateData.damage_note = damageNote || '';
        // 同步计算实际押金（押金 - 损坏扣款）
        var _baseDeposit = parseFloat(order.final_deposit || order.estimated_deposit || 0);
        updateData.actual_deposit = Math.max(0, +(_baseDeposit - fee).toFixed(2));
      }
      await db.collection('orders').doc(orderId).update(updateData);

      // 库存由设备状态自动聚合（释放设备后设备变「在库」，库存自动+1）
      // 释放设备：将绑定设备状态重置为「在库」，解绑订单关联
      var releaseDeviceId = order.deviceId || order.device_id || '';
      if (releaseDeviceId) {
        try {
          // ★ 先查询设备获取 product_id（用于同步 products.stock）
          var releaseDeviceProductId = '';
          try {
            var releaseDevDoc = await db.collection('devices').doc(releaseDeviceId).get();
            var releaseDev = Array.isArray(releaseDevDoc.data) ? releaseDevDoc.data[0] : releaseDevDoc.data;
            releaseDeviceProductId = (releaseDev && releaseDev.product_id) ? String(releaseDev.product_id).trim() : '';
          } catch (eDevGet) {
            console.warn('[return-verify] 查询设备 product_id 失败:', eDevGet.message);
          }

          await db.collection('devices').doc(releaseDeviceId).update({
            status: '在库',
            current_order_id: '',
            updated_at: new Date()
          });
          console.log('[return-verify] 设备已释放 deviceId=' + releaseDeviceId);

          // ★ 同步回补 products.stock（与设备表保持一致）
          if (releaseDeviceProductId) {
            try {
              await db.collection('products').doc(releaseDeviceProductId).update({
                data: { stock: _.inc(1), updated_at: new Date() }
              });
              console.log('[return-verify] products.stock +1 for productId=' + releaseDeviceProductId);
            } catch (eStock) {
              console.warn('[return-verify] products.stock 回补失败（非阻塞）:', eStock.message);
            }
          }
        } catch (deviceErr) {
          // 设备释放失败 → 回滚订单状态，杜绝订单已完成但设备仍为「租赁中」的脏数据
          console.error('[return-verify] 设备释放失败，回滚订单 orderId=' + orderId, deviceErr.message);
          var rollbackData = {
            status: prevStatus,
            orderStatus: prevOrderStatus,
            deviceStatus: prevDeviceStatus,
            device_sn: prevDeviceSn,
            device_id: prevDeviceId,
            deviceId: prevDeviceId,
            deviceCode: prevDeviceSn,
            returned_at: prevReturnedAt,
            updated_at: new Date()
          };
          await db.collection('orders').doc(orderId).update(rollbackData).catch(function(rbErr) {
            console.error('[return-verify] ⚠️ 回滚订单失败，需人工处理 orderId=' + orderId, rbErr.message);
          });
          return res.status(500).json({ error: '设备释放失败，订单已回滚：' + deviceErr.message });
        }
      }

      // ═══════════════════════════════════════════════════════════
      // 发放经验值：订单完成时 1元=1经验，无损按时归还额外+5
      // ═══════════════════════════════════════════════════════════
      var orderOpenid = order._openid || '';
      if (orderOpenid && !order.exp_awarded) {
        try {
          var earnExp = Math.floor(parseFloat(order.total_rent || order.paid_amount || 0));
          // 无损归还额外奖励
          var isUndamaged = !order.damage_fee || parseFloat(order.damage_fee) <= 0;
          if (isUndamaged && earnExp > 0) earnExp += 5;

          if (earnExp > 0) {
            await db.collection('users').where({ _openid: orderOpenid }).update({
              data: { exp: _.inc(earnExp), member_exp: _.inc(earnExp) }
            });
            // 写入经验流水
            var curUser = await db.collection('users').where({ _openid: orderOpenid }).get();
            var newExp = 0;
            if (curUser.data && curUser.data.length > 0) newExp = curUser.data[0].exp || 0;
            try {
              await db.collection('exp_logs').add({
                data: {
                  _openid: orderOpenid,
                  type: 'earn',
                  amount: earnExp,
                  balance: newExp,
                  source: isUndamaged ? 'return_bonus' : 'payment',
                  order_id: orderId,
                  remark: '订单完成' + (isUndamaged ? '（含无损归还奖励+5）' : ''),
                  created_at: new Date()
                }
              });
            } catch (e) { /* 日志不阻塞 */ }
            console.log('[return-verify] 经验已发放 openid=' + orderOpenid + ' exp=' + earnExp);
          }
        } catch (e) {
          console.error('[return-verify] 经验发放失败:', e.message);
        }
      }
      // 标记经验已发放（防重复）
      if (orderOpenid && !order.exp_awarded) {
        try {
          await db.collection('orders').doc(orderId).update({ exp_awarded: true });
        } catch (e) { /* 不阻塞 */ }
      }

      notifyUser(orderId, 'return_completed');
      // ★ 微信订单状态同步：订单完成后同步到微信订单管理
      syncWxOrderStatus(order.order_no || orderId);
      res.json({ msg: '验收完成，订单已完成' + (fee > 0 ? '（含损坏扣款 ¥' + fee.toFixed(2) + '）' : '') });
    } else {
      res.status(400).json({ error: '无效操作' });
    }
  } catch (e) { hideError(res, e); }
});

// ==================== 强制完成订单（后台运营兜底） ====================
// 用于处理因流程异常卡在「租赁中」(status=4) 无法正常走归还验收的订单。
// 严格约束：仅管理员可操作；仅「租赁中」可执行；执行标准完结收尾（复用归还验收 complete 分支逻辑）。
app.post('/api/orders/force-complete', authRequired, async (req, res) => {
  try {
    // 1) 权限校验：仅总号/分校管理员可访问（普通角色一律拦截）
    if (req.adminRole !== 'super' && req.adminRole !== 'branch') {
      return res.status(403).json({ error: '无权限：仅管理员可执行强制完成' });
    }
    var { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });

    var doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    // 权限边界：分校管理员仅可操作本分校订单，杜绝跨分校越权
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    // 2) 前置强校验：仅「租赁中」(status=4) 可执行，其余状态一律拒绝
    if (Number(order.status) !== 4) {
      return res.status(400).json({ error: '当前订单状态不可执行强制完成' });
    }

    // ===== 3) 标准完结收尾逻辑（与归还验收 complete 分支完全一致） =====
    // 保存前值用于设备释放失败时回滚
    var prevStatus = order.status;
    var prevOrderStatus = order.orderStatus || '';
    var prevDeviceStatus = order.deviceStatus || '';
    var prevDeviceSn = order.device_sn || '';
    var prevDeviceId = order.device_id || order.deviceId || '';
    var prevReturnedAt = order.returned_at || null;

    var now = new Date();
    var updateData = {
      status: 5,
      orderStatus: 'completed',
      deviceStatus: 'returned',
      returned_at: now,
      updated_at: now,
      // 兜底操作留痕标记（附加字段，不改动状态/押金枚举）
      force_completed: true,
      force_completed_by: req.adminRole + (req.adminSchool ? (':' + req.adminSchool) : ''),
      force_completed_at: now
    };
    await db.collection('orders').doc(orderId).update(updateData);

    // 释放设备 + 回补库存（与 return-verify 逐调用一致）
    var releaseDeviceId = order.deviceId || order.device_id || '';
    if (releaseDeviceId) {
      try {
        var releaseDeviceProductId = '';
        try {
          var releaseDevDoc = await db.collection('devices').doc(releaseDeviceId).get();
          var releaseDev = Array.isArray(releaseDevDoc.data) ? releaseDevDoc.data[0] : releaseDevDoc.data;
          releaseDeviceProductId = (releaseDev && releaseDev.product_id) ? String(releaseDev.product_id).trim() : '';
        } catch (eDevGet) {
          console.warn('[force-complete] 查询设备 product_id 失败:', eDevGet.message);
        }

        await db.collection('devices').doc(releaseDeviceId).update({
          status: '在库',
          current_order_id: '',
          updated_at: now
        });
        console.log('[force-complete] 设备已释放 deviceId=' + releaseDeviceId);

        if (releaseDeviceProductId) {
          try {
            await db.collection('products').doc(releaseDeviceProductId).update({
              data: { stock: _.inc(1), updated_at: now }
            });
            console.log('[force-complete] products.stock +1 for productId=' + releaseDeviceProductId);
          } catch (eStock) {
            console.warn('[force-complete] products.stock 回补失败（非阻塞）:', eStock.message);
          }
        }
      } catch (deviceErr) {
        // 设备释放失败 → 回滚订单状态，避免「订单已完成但设备仍占用」脏数据
        console.error('[force-complete] 设备释放失败，回滚订单 orderId=' + orderId, deviceErr.message);
        var rollbackData = {
          status: prevStatus,
          orderStatus: prevOrderStatus,
          deviceStatus: prevDeviceStatus,
          device_sn: prevDeviceSn,
          device_id: prevDeviceId,
          deviceId: prevDeviceId,
          deviceCode: prevDeviceSn,
          returned_at: prevReturnedAt,
          updated_at: now,
          force_completed: false
        };
        await db.collection('orders').doc(orderId).update(rollbackData).catch(function(rbErr) {
          console.error('[force-complete] ⚠️ 回滚订单失败，需人工处理 orderId=' + orderId, rbErr.message);
        });
        return res.status(500).json({ error: '设备释放失败，订单已回滚：' + deviceErr.message });
      }
    }

    // 发放经验值（与正常完结一致，防重复）
    var orderOpenid = order._openid || '';
    if (orderOpenid && !order.exp_awarded) {
      try {
        var earnExp = Math.floor(parseFloat(order.total_rent || order.paid_amount || 0));
        var isUndamaged = !order.damage_fee || parseFloat(order.damage_fee) <= 0;
        if (isUndamaged && earnExp > 0) earnExp += 5;
        if (earnExp > 0) {
          await db.collection('users').where({ _openid: orderOpenid }).update({
            data: { exp: _.inc(earnExp), member_exp: _.inc(earnExp) }
          });
          var curUser = await db.collection('users').where({ _openid: orderOpenid }).get();
          var newExp = (curUser.data && curUser.data.length > 0) ? (curUser.data[0].exp || 0) : 0;
          try {
            await db.collection('exp_logs').add({
              data: {
                _openid: orderOpenid,
                type: 'earn',
                amount: earnExp,
                balance: newExp,
                source: isUndamaged ? 'return_bonus' : 'payment',
                order_id: orderId,
                remark: '订单强制完成' + (isUndamaged ? '（含无损归还奖励+5）' : ''),
                created_at: now
              }
            });
          } catch (e) { /* 日志不阻塞 */ }
        }
      } catch (e) {
        console.error('[force-complete] 经验发放失败:', e.message);
      }
      try { await db.collection('orders').doc(orderId).update({ exp_awarded: true }); } catch (e) { /* 不阻塞 */ }
    }

    // 4) 操作留痕：写入管理端操作日志
    try {
      await db.collection('admin_logs').add({
        action: 'force_complete_order',
        order_id: orderId,
        order_no: order.order_no || orderId,
        operator_role: req.adminRole,
        operator: req.adminSchool || (req.adminRole === 'super' ? '总号' : '分校'),
        remark: '强制完成订单（兜底）',
        created_at: now
      });
    } catch (eLog) { console.warn('[force-complete] 操作日志写入失败（非阻塞）:', eLog.message); }

    // 订单完成通知（押金随 status=5 自动进入待退还流程，与正常完结一致）
    notifyUser(orderId, 'return_completed');
    // ★ 微信订单状态同步：强制完成后同步到微信订单管理
    syncWxOrderStatus(order.order_no || orderId);
    res.json({ msg: '订单已强制完成' });
  } catch (e) { hideError(res, e); }
});

// 设置订单来源/学校归属
// ==================== 管理端取消订单 ====================
app.post('/api/orders/cancel', authRequired, async (req, res) => {
  try {
    const { orderId, cancelReason } = req.body;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });

    const doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    // 可取消状态：1-待审核押金、2-待付款、3-待发货
    var canCancel = Number(order.status) === 1 || Number(order.status) === 2 || Number(order.status) === 3;
    if (!canCancel) return res.status(400).json({ error: '该订单状态不允许取消（仅待审核押金/待付款/待发货可取消）' });

    // 库存由设备状态自动聚合（释放设备后设备变「在库」，库存自动+1）
    // 释放设备：如果订单已绑定设备，重置为「在库」
    var cancelDeviceId = order.deviceId || order.device_id || '';
    if (cancelDeviceId) {
      try {
        // ★ 先查询设备获取 product_id（用于同步 products.stock）
        var cancelDeviceProductId = '';
        try {
          var cancelDevDoc = await db.collection('devices').doc(cancelDeviceId).get();
          var cancelDev = Array.isArray(cancelDevDoc.data) ? cancelDevDoc.data[0] : cancelDevDoc.data;
          cancelDeviceProductId = (cancelDev && cancelDev.product_id) ? String(cancelDev.product_id).trim() : '';
        } catch (eDevGet) {
          console.warn('[cancel] 查询设备 product_id 失败:', eDevGet.message);
        }

        await db.collection('devices').doc(cancelDeviceId).update({
          status: '在库',
          current_order_id: '',
          updated_at: new Date()
        });
        console.log('[cancel] 设备已释放 deviceId=' + cancelDeviceId);

        // ★ 同步回补 products.stock（与设备表保持一致）
        if (cancelDeviceProductId) {
          try {
            await db.collection('products').doc(cancelDeviceProductId).update({
              data: { stock: _.inc(1), updated_at: new Date() }
            });
            console.log('[cancel] products.stock +1 for productId=' + cancelDeviceProductId);
          } catch (eStock) {
            console.warn('[cancel] products.stock 回补失败（非阻塞）:', eStock.message);
          }
        }
      } catch (e) {
        console.error('[cancel] 设备释放失败（不阻塞取消） deviceId=' + cancelDeviceId, e.message);
      }
    }

    // 恢复优惠券
    if (order.coupon_info && order.coupon_info.coupon_id) {
      try {
        await db.collection('user_coupons').doc(order.coupon_info.coupon_id).update({
          status: 1, used_order_id: '', used_at: null
        });
      } catch (e) { console.warn('[取消订单] 恢复优惠券失败:', e.message); }
    }

    // 更新订单状态
    await db.collection('orders').doc(orderId).update({
      status: 0,
      orderStatus: 'cancelled',
      cancel_reason: cancelReason || '管理员取消',
      cancelled_at: new Date(),
      updated_at: new Date()
    });

    notifyUser(orderId, 'order_cancelled', { reason: cancelReason || '管理员取消' });
    res.json({ msg: '订单已取消' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/orders/set-source', authRequired, async (req, res) => {
  try {
    var { orderId, source, schoolId, branchId, contactPerson } = req.body;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });
    // 校验分点归属
    var srcDoc = await db.collection('orders').doc(orderId).get();
    var srcOrder = Array.isArray(srcDoc.data) ? srcDoc.data[0] : srcDoc.data;
    if (!srcOrder) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, srcOrder)) return res.status(403).json({ error: '无权限操作此订单' });
    var updateData = { order_source: source || '', updated_at: new Date() };
    if (contactPerson !== undefined) updateData.order_contact_person = contactPerson || '';
    // 同步写入标准化学校字段
    if (schoolId) {
      updateData.schoolId = schoolId;
      updateData.branchId = branchId || schoolId;
      updateData.schoolName = source || '';
      updateData.branchName = source || '';
    } else if (source) {
      var resolvedId = resolveBranchId(source);
      if (resolvedId) {
        updateData.schoolId = resolvedId;
        updateData.branchId = resolvedId;
        updateData.schoolName = source;
        updateData.branchName = source;
      }
    }
    if (contactPerson !== undefined) updateData.contactAdminName = contactPerson || '';
    await db.collection('orders').doc(orderId).update(updateData);
    res.json({ msg: '来源已更新' });
  } catch (e) { hideError(res, e); }
});

// 订单详情（供后台查看完整信息）
app.get('/api/orders/detail', authRequired, async (req, res) => {
  try {
    var { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });
    var doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限查看此订单' });

    // 补充保险信息
    try {
      var { data: insurances } = await db.collection('order_insurances').where({ order_id: orderId }).get();
      order.insurances = Array.isArray(insurances) ? insurances : [];
    } catch (e) { order.insurances = []; }

    // 补充续租记录
    try {
      var { data: renewals } = await db.collection('renewals').where({ order_id: orderId }).orderBy('created_at', 'asc').get();
      order.renewals = Array.isArray(renewals) ? renewals : [];
    } catch (e) { order.renewals = []; }

    // 自动关联用户认证信息
    try {
      var userOpenid = order._openid;
      if (userOpenid) {
        var { data: verifications } = await db.collection('verifications')
          .where({ _openid: userOpenid, status: 2 })
          .orderBy('created_at', 'desc').limit(1).get();
        var verList = Array.isArray(verifications) ? verifications : [];
        if (verList.length > 0) {
          var ver = verList[0];
          order.verification = {
            auth_type: ver.auth_type,
            real_name: ver.real_name || '',
            // 分点管理员仅看脱敏身份证号，总号可看完整
            id_card: req.adminRole === 'super' ? (ver.id_card || '') : maskIdCard(ver.id_card || ''),
            id_card_front_img: ver.id_card_front_img || '',
            id_card_back_img: ver.id_card_back_img || '',
            student_card_img: ver.student_card_img || '',
            xuexin_img: ver.xuexin_img || '',
            sesame_img: ver.sesame_img || ''
          };
        }
      }
    } catch (e) { /* 关联失败不阻塞 */ }

    // 手写签名图片：cloud:// 转临时 HTTPS 链接
    try {
      if (order.signature_image && order.signature_image.startsWith('cloud://')) {
        console.log('[order-detail] 转换签名图片:', order.signature_image);
        var tempRes = await tcb.getTempFileURL({ fileList: [order.signature_image] });
        console.log('[order-detail] getTempFileURL 返回:', JSON.stringify(tempRes));
        if (tempRes.fileList && tempRes.fileList[0] && tempRes.fileList[0].tempFileURL) {
          order.signature_image_url = tempRes.fileList[0].tempFileURL;
          console.log('[order-detail] 签名HTTPS链接已生成');
        } else {
          console.warn('[order-detail] getTempFileURL 返回异常：未获取到临时链接', JSON.stringify(tempRes));
        }
      } else {
        console.log('[order-detail] 订单无signature_image字段或非cloud://格式:', typeof order.signature_image, order.signature_image ? order.signature_image.substring(0, 30) : '(空)');
      }
    } catch (e) {
      console.error('[order-detail] 签名转换失败:', e.message || e);
    }

    // 补充履约凭证
    try {
      var { data: vouchers } = await db.collection('order_delivery_voucher')
        .where({ order_id: orderId }).orderBy('created_at', 'asc').get();
      order.delivery_vouchers = Array.isArray(vouchers) ? vouchers : [];
      // 转换 cloud:// 为临时链接
      if (order.delivery_vouchers.length > 0) {
        var cloudFiles = [];
        order.delivery_vouchers.forEach(function(v) {
          if (v.voucher_url && v.voucher_url.startsWith('cloud://')) {
            cloudFiles.push(v.voucher_url);
          }
        });
        if (cloudFiles.length > 0) {
          try {
            var tempRes = await tcb.getTempFileURL({ fileList: cloudFiles });
            var urlMap = {};
            (tempRes.fileList || []).forEach(function(item, idx) {
              if (item.tempFileURL) urlMap[cloudFiles[idx]] = item.tempFileURL;
            });
            order.delivery_vouchers.forEach(function(v) {
              if (urlMap[v.voucher_url]) v.temp_url = urlMap[v.voucher_url];
            });
          } catch (e) { /* 转换失败不阻塞 */ }
        }
      }
    } catch (e) { order.delivery_vouchers = []; }

    res.json({ order });
  } catch (e) { hideError(res, e); }
});

// ==================== 飞书多维表格数据（统一入口） ====================
const { execSync } = require('child_process');

// 飞书数据缓存（5分钟有效，避免每次请求都调 lark-cli）
var feishuCache = { data: null, time: 0 };

function getFeishuData() {
  return new Promise(function(resolve, reject) {
    var now = Date.now();
    if (feishuCache.data && (now - feishuCache.time) < 300000) {
      return resolve(feishuCache.data);
    }
    try {
      var baseToken = 'YQX5bgiJ0a0XaKsCtcNcOHNQnuf';
      var devicesStdout = runLarkCli('lark-cli base +record-list --base-token ' + baseToken + ' --table-id tbllBH6szspsN99i --limit 500 --as user');
      var schoolsStdout = runLarkCli('lark-cli base +record-list --base-token ' + baseToken + ' --table-id tblDES6lAydkFyba --limit 200 --as user');
      var deviceRows = parseLarkTable(devicesStdout);
      var schoolRows = parseLarkTable(schoolsStdout);

      var modelSet = {};
      var models = [];
      deviceRows.forEach(function(d) {
        if (d['机型'] && !modelSet[d['机型']]) { modelSet[d['机型']] = true; models.push(d['机型']); }
      });
      var schools = schoolRows.map(function(s) {
        return { id: s._record_id, name: s['学校'] || '' };
      }).filter(function(s) { return s.name; });
      var devices = deviceRows.map(function(d) {
        return { record_id: d._record_id, serial_number: d['设备序列号'] || '', model: d['机型'] || '', school: d['所属学校'] || '' };
      });

      feishuCache = { data: { models: models, schools: schools, devices: devices }, time: now };
      resolve(feishuCache.data);
    } catch(e) { reject(e); }
  });
}

// 解析 lark-cli Markdown table 输出，返回 [{col1, col2, ...}, ...]
function parseLarkTable(stdout) {
  var rows = [];
  var lines = stdout.split('\n');
  var headers = [];
  var inHeader = false, inData = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('| --- |') >= 0 && inHeader) { inHeader = false; inData = true; continue; }
    if (inData && line.indexOf('| rec') === 0) {
      var cols = line.split('|').map(function(s) { return s.trim(); });
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        var val = cols[j + 1] || '';
        // 去掉 JSON 数组格式 ["xxx"] → xxx
        if (val.indexOf('["') === 0) {
          try { val = JSON.parse(val)[0] || ''; } catch(e) {}
        }
        row[headers[j]] = val;
      }
      if (row._record_id) rows.push(row);
    }
    if (inData && line.indexOf('Meta:') === 0) break;
    // 找表头行
    if (!inHeader && !inData && line.indexOf('| _record_id |') === 0) {
      headers = line.split('|').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
      inHeader = true;
    }
  }
  return rows;
}

// 执行 lark-cli 命令
function runLarkCli(cmd) {
  // lark-cli 不在 package.json 中，统一用 npx 调用（本地/Docker 均兼容）
  var finalCmd = cmd.replace('lark-cli', 'npx --yes lark-cli');

  var shell;
  if (process.platform === 'win32') {
    var gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    try { require('fs').accessSync(gitBash); shell = gitBash; } catch(e) {}
    if (!shell) shell = process.env.ComSpec || 'cmd.exe';
  }
  return execSync(finalCmd, { timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, shell: shell });
}

app.get('/api/feishu-data', authRequired, async (req, res) => {
  try {
    var data = await getFeishuData();
    res.json(data);
  } catch (e) { hideError(res, e); }
});

// ==================== 分校账号管理 ====================
app.get('/api/branch-admins', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅超级管理员可操作' });
    var { data: list } = await db.collection('branch_admins').orderBy('created_at', 'desc').get();
    list = Array.isArray(list) ? list : [];
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

app.post('/api/branch-admins/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅超级管理员可操作' });
    var { adminId, school, password, status } = req.body;
    if (!school) return res.status(400).json({ error: '学校名称必填' });
    if (!adminId && !password) return res.status(400).json({ error: '新建账号时密码必填' });
    var data = { school, status: status || 1, updated_at: new Date() };
    if (password) {
      data.password = password;
    }
    if (adminId) {
      await db.collection('branch_admins').doc(adminId).update(data);
    } else {
      data.created_at = new Date();
      await db.collection('branch_admins').add(data);
    }
    res.json({ msg: adminId ? '已更新' : '已创建' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/branch-admins/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅超级管理员可操作' });
    var { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: '缺少账号ID' });
    await db.collection('branch_admins').doc(adminId).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// ==================== 分点/学校标准化管理 ====================

// （schoolNameToIdMap / loadBranchMap / resolveBranchId 已在文件头部定义，此处复用）

// 分点列表（所有角色可查看）
app.get('/api/branches', authRequired, async (req, res) => {
  try {
    var where = { status: 'active' };  // 只返回活跃分点，与工作台/排名一致
    if (req.adminRole === 'branch' && req.adminSchool) {
      var bid = resolveBranchId(req.adminSchool);
      if (bid) where.schoolId = bid;
    }
    var { data: list } = await db.collection('branches').where(where).orderBy('schoolId', 'asc').get();
    list = Array.isArray(list) ? list : [];
    // 过滤掉 schoolId 或 schoolName 为空的脏数据
    list = list.filter(function(b) { return b.schoolId && b.schoolName; });
    res.json({ list, branchId: req.adminBranchId || '' });
  } catch (e) { hideError(res, e); }
});

// 保存分点（仅主管理员）
app.post('/api/branches/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { branchId: editId, schoolId, schoolName, branchCode, branchName, shortName,
          status, address, contactName, contactPhone } = req.body;
    if (!schoolId || !schoolName) return res.status(400).json({ error: '学校代码和名称必填' });

    // 校验 schoolId 唯一性
    var { data: existing } = await db.collection('branches')
      .where({ schoolId: schoolId }).get();
    var exList = Array.isArray(existing) ? existing : [];
    if (exList.length > 0 && (!editId || exList[0]._id !== editId)) {
      return res.status(400).json({ error: '学校代码 ' + schoolId + ' 已存在' });
    }

    var data = {
      schoolId: schoolId,
      schoolName: schoolName,
      branchCode: branchCode || schoolId,
      branchName: branchName || schoolName,
      shortName: shortName || schoolName,
      status: status || 'active',
      address: address || '',
      contactName: contactName || '',
      contactPhone: contactPhone || '',
      updatedAt: new Date()
    };

    if (editId) {
      await db.collection('branches').doc(editId).update(data);
    } else {
      data.createdAt = new Date();
      await db.collection('branches').add(data);
    }
    // 刷新映射缓存
    await loadBranchMap();
    res.json({ msg: editId ? '已更新' : '已创建' });
  } catch (e) { hideError(res, e); }
});

// 删除分点（仅主管理员，软删除）
app.post('/api/branches/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: '缺少分点ID' });
    await db.collection('branches').doc(branchId).update({ status: 'disabled', updatedAt: new Date() });
    await loadBranchMap();
    res.json({ msg: '已禁用' });
  } catch (e) { hideError(res, e); }
});

// ==================== 设备管理 ====================
app.get('/api/devices', authRequired, async (req, res) => {
  try {
    var { status, product_id, model, school, ownerBranchId } = req.query;
    var where = {};
    if (status) where.status = status;
    if (product_id) where.product_id = product_id;
    if (model) where.model = model;

    // 分校管理员只能看本校设备（优先 branchId，回退文字匹配）
    if (req.adminRole === 'branch') {
      if (req.adminBranchId && req.adminSchool) {
        // 优先用 currentBranchId 匹配，回退 school 文字匹配（老数据）
        where = _.or([
          { currentBranchId: req.adminBranchId },
          { ownerBranchId: req.adminBranchId },
          { school: req.adminSchool }
        ]);
      } else if (req.adminSchool) {
        where.school = req.adminSchool;
      }
    } else if (ownerBranchId) {
      where = _.or([{ ownerBranchId: ownerBranchId }, { currentBranchId: ownerBranchId }]);
    } else if (school) {
      where.school = school;
    }

    var { data: list } = await db.collection('devices').where(where).orderBy('serial_number', 'asc').get();
    list = Array.isArray(list) ? list : [];
    res.json({ list, role: req.adminRole, school: req.adminSchool, branchId: req.adminBranchId || '' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/devices/save', authRequired, async (req, res) => {
  try {
    var { deviceId, serial_number, model, school, school_id, product_id, product_name,
          ownerBranchId, currentBranchId, deviceCode, categoryCode } = req.body;
    if (!serial_number) return res.status(400).json({ error: '请输入设备序列号' });
    // 解析学校归属
    var ownerBid = ownerBranchId || resolveBranchId(school || '');
    var curBid = currentBranchId || ownerBid;
    var devCode = deviceCode || (ownerBid ? ownerBid + '-' + (categoryCode || 'DEV') + '-' + serial_number.substring(0, 6).toUpperCase() : serial_number);

    var data = {
      serial_number, model: model || '',
      school: school || '',                          // 学校中文名（展示用，兼容老数据）
      school_id: school_id || '',
      product_id: product_id || '',
      product_name: product_name || '',
      // === 新标准化字段 ===
      deviceCode: devCode,
      categoryCode: categoryCode || '',
      ownerBranchId: ownerBid,
      ownerBranchName: school || '',
      currentBranchId: curBid,
      currentBranchName: school || '',
      currentSchoolId: ownerBid,
      currentSchoolName: school || '',
      updated_at: new Date()
    };
    if (deviceId) {
      await db.collection('devices').doc(deviceId).update(data);
    } else {
      data.status = '在库';       // 新建设备默认为「在库」
      data.created_at = new Date();
      await db.collection('devices').add(data);
      // ★ 同步增加 products.stock（新设备入库）
      if (product_id) {
        try {
          await db.collection('products').doc(product_id).update({
            data: { stock: _.inc(1), updated_at: new Date() }
          });
          console.log('[devices/save] products.stock +1 for productId=' + product_id);
        } catch (eStock) {
          console.warn('[devices/save] products.stock 增加失败（非阻塞）:', eStock.message);
        }
      }
    }
    res.json({ msg: deviceId ? '已更新' : '已添加', deviceCode: devCode });
  } catch (e) { hideError(res, e); }
});

app.post('/api/devices/set-status', authRequired, async (req, res) => {
  try {
    var { deviceId, status } = req.body;
    if (!deviceId || !status) return res.status(400).json({ error: '缺少参数' });
    // 标准化状态：统一使用中文状态值「在库」「租赁中」「其他平台租赁中」「维修中」
    // 兼容旧英文状态值自动转换（全程仅使用中文，禁止英文枚举）
    var statusMap = {
      '在库': '在库', 'available': '在库',
      '租赁中': '租赁中', '在租': '租赁中', 'rented': '租赁中',
      '其他平台租赁中': '其他平台租赁中', 'external': '其他平台租赁中',
      '维修中': '维修中', 'maintenance': '维修中'
    };
    var normalizedStatus = statusMap[status] || status;
    var validStatuses = ['在库', '租赁中', '其他平台租赁中', '维修中'];
    if (!validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ error: '无效状态: ' + status + '，有效值为：在库、租赁中、其他平台租赁中、维修中' });
    }
    await db.collection('devices').doc(deviceId).update({
      status: normalizedStatus, updated_at: new Date()
    });
    res.json({ msg: '状态已更新为「' + normalizedStatus + '」' });
  } catch (e) { hideError(res, e); }
});

// 【修复2】批量重置设备状态 — 将"未知"/空值/旧英文状态的历史设备一键重置为中文状态
app.post('/api/devices/reset-status', authRequired, async (req, res) => {
  try {
    var { deviceIds } = req.body;
    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return res.status(400).json({ error: '请选择要重置的设备' });
    }
    // 英文→中文状态映射
    var migrateMap = {
      'available': '在库', '': '在库',
      'rented': '租赁中', '在租': '租赁中',
      'maintenance': '维修中'
    };
    var count = 0;
    for (var deviceId of deviceIds) {
      var doc = await db.collection('devices').doc(deviceId).get();
      var device = Array.isArray(doc.data) ? doc.data[0] : doc.data;
      if (!device) continue;
      var curStatus = device.status;
      var newStatus = migrateMap[curStatus];
      if (newStatus || !curStatus || curStatus === '未知') {
        await db.collection('devices').doc(deviceId).update({
          status: newStatus || '在库', updated_at: new Date()
        });
        count++;
      }
    }
    res.json({ msg: '已迁移 ' + count + ' 台设备状态', count: count });
  } catch (e) { hideError(res, e); }
});

// 一键批量迁移：将数据库中所有英文/空值状态统一转为中文
app.post('/api/devices/migrate-status', authRequired, async (req, res) => {
  try {
    var migrateMap = {
      'available': '在库', '在库': '在库',
      'rented': '租赁中', '在租': '租赁中', '租赁中': '租赁中',
      '其他平台租赁中': '其他平台租赁中', 'external': '其他平台租赁中',
      'maintenance': '维修中', '维修中': '维修中'
    };
    var stats = { '在库': 0, '租赁中': 0, '其他平台租赁中': 0, '维修中': 0, '补全(无状态字段)': 0, '已是最新': 0 };
    // 分批处理（CloudBase 单次查询上限 1000）
    var batchSize = 200;
    var cursor = 0;
    var hasMore = true;
    while (hasMore) {
      var { data: batch } = await db.collection('devices').skip(cursor).limit(batchSize).get();
      batch = Array.isArray(batch) ? batch : [];
      if (batch.length === 0) { hasMore = false; break; }
      for (var device of batch) {
        // ① 无 status 字段 / 空值 / '未知' → 统一补全为「在库」
        if (!device.status || device.status === '' || device.status === '未知') {
          try {
            await db.collection('devices').doc(device._id).update({
              status: '在库', updated_at: new Date()
            });
            stats['补全(无状态字段)']++;
          } catch (e) {
            console.error('[migrate-status] 补全失败 deviceId=' + device._id, e.message);
          }
          continue;
        }
        // ② 英文状态 → 中文映射
        var cur = device.status;
        var target = migrateMap[cur];
        if (target && target !== cur) {
          try {
            await db.collection('devices').doc(device._id).update({
              status: target, updated_at: new Date()
            });
            stats[target] = (stats[target] || 0) + 1;
          } catch (e) {
            console.error('[migrate-status] 更新失败 deviceId=' + device._id, e.message);
          }
        } else {
          stats['已是最新']++;
        }
      }
      cursor += batchSize;
      if (batch.length < batchSize) hasMore = false;
    }
    res.json({
      msg: '迁移完成：补全' + stats['补全(无状态字段)'] + '台 / 在库×' + stats['在库']
        + ' / 租赁中×' + stats['租赁中'] + ' / 其他平台租赁中×' + stats['其他平台租赁中']
        + ' / 维修中×' + stats['维修中']
        + ' / 已是最新×' + stats['已是最新'],
      stats: stats
    });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 设备关联诊断：检查所有设备与商品的关联状态
// ═══════════════════════════════════════════════════════════════
app.get('/api/devices/diagnose', authRequired, async (req, res) => {
  try {
    // 拉取全部商品，建立 _id→name 和 name→_id 索引
    var { data: allProducts } = await db.collection('products').limit(1000).get();
    allProducts = Array.isArray(allProducts) ? allProducts : [];
    var productById = {};    // _id → name
    var productByName = {};  // name → _id
    allProducts.forEach(function(p) {
      var pid = (p._id || '').trim();
      var pname = (p.name || '').trim();
      if (pid) productById[pid] = pname;
      if (pname) productByName[pname] = pid;
    });

    // 分批拉取全部设备
    var allDevices = [];
    var batchSize = 500;
    var cursor = 0;
    while (true) {
      var { data: batch } = await db.collection('devices').skip(cursor).limit(batchSize).get();
      batch = Array.isArray(batch) ? batch : [];
      if (batch.length === 0) break;
      allDevices = allDevices.concat(batch);
      cursor += batchSize;
      if (batch.length < batchSize) break;
    }

    // 分类诊断
    var healthy = [];       // 关联正常
    var orphanNoLink = [];  // 既无 product_id 也无 model
    var orphanBadPid = [];  // product_id 有值但找不到对应商品
    var orphanBadModel = [];// model 有值但找不到对应商品
    var orphanMismatch = [];// product_id 和 model 指向不同商品

    allDevices.forEach(function(d) {
      var pid = (d.product_id || '').trim();
      var model = (d.model || '').trim();
      var hasPid = !!pid;
      var hasModel = !!model;
      var pidValid = hasPid && !!productById[pid];
      var modelValid = hasModel && !!productByName[model];

      if (!hasPid && !hasModel) {
        orphanNoLink.push(d);
      } else if (pidValid && modelValid) {
        // 两者都有且都有效：检查是否指向同一商品
        var pidProductName = productById[pid];
        var modelProductId = productByName[model];
        if (pidProductName === model || productById[modelProductId] === model) {
          healthy.push(d);
        } else {
          orphanMismatch.push({ device: d, pidProduct: pidProductName, modelProduct: model });
        }
      } else if (pidValid && !modelValid) {
        // 只有 product_id 有效
        healthy.push(d);
      } else if (modelValid && !pidValid) {
        // 只有 model 有效
        healthy.push(d);
      } else if (hasPid && !pidValid) {
        orphanBadPid.push({ device: d, badPid: pid });
      } else if (hasModel && !modelValid) {
        orphanBadModel.push({ device: d, badModel: model });
      }
    });

    // 汇总
    var total = allDevices.length;
    var orphanCount = orphanNoLink.length + orphanBadPid.length + orphanBadModel.length + orphanMismatch.length;

    res.json({
      total: total,
      healthy: healthy.length,
      orphan: orphanCount,
      details: {
        noLink: orphanNoLink.map(function(d) { return { _id: d._id, sn: d.serial_number, model: d.model || '', status: d.status || '无' }; }),
        badProductId: orphanBadPid.map(function(x) { return { _id: x.device._id, sn: x.device.serial_number, badProductId: x.badPid, model: x.device.model || '' }; }),
        badModel: orphanBadModel.map(function(x) { return { _id: x.device._id, sn: x.device.serial_number, badModel: x.badModel, product_id: x.device.product_id || '' }; }),
        mismatch: orphanMismatch.map(function(x) { return { _id: x.device._id, sn: x.device.serial_number, product_id: x.device.product_id, model: x.device.model, pidPointsTo: x.pidProduct, modelPointsTo: x.modelProduct }; }),
        productIndex: { totalProducts: allProducts.length, names: allProducts.map(function(p) { return p.name; }) }
      }
    });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 设备关联修复：批量修复无效 product_id
// ═══════════════════════════════════════════════════════════════
app.post('/api/devices/repair', authRequired, async (req, res) => {
  try {
    // 建立商品 name→_id 索引
    var { data: allProducts } = await db.collection('products').limit(1000).get();
    allProducts = Array.isArray(allProducts) ? allProducts : [];
    var productByName = {};
    allProducts.forEach(function(p) {
      var name = (p.name || '').trim();
      if (name) productByName[name] = p._id;
    });

    // 拉取全部设备
    var allDevices = [];
    var batchSize = 500, cursor = 0;
    while (true) {
      var { data: batch } = await db.collection('devices').skip(cursor).limit(batchSize).get();
      batch = Array.isArray(batch) ? batch : [];
      if (!batch.length) break;
      allDevices = allDevices.concat(batch);
      cursor += batchSize;
      if (batch.length < batchSize) break;
    }

    var stats = { fixed: 0, cleared: 0, skipped: 0 };
    // 预建立 product _id 集合用于快速校验
    var validPids = {};
    allProducts.forEach(function(p) { validPids[p._id] = true; });

    for (var i = 0; i < allDevices.length; i++) {
      var d = allDevices[i];
      var pid = (d.product_id || '').trim();
      var model = (d.model || '').trim();

      // ① product_id 有效 → 跳过
      if (pid && validPids[pid]) { stats.skipped++; continue; }

      // ② product_id 无效或为空 → 尝试用 model 修复
      if (model && productByName[model]) {
        // model 能匹配到商品 → 修正 product_id
        await db.collection('devices').doc(d._id).update({
          product_id: productByName[model],
          product_name: model,
          updated_at: new Date()
        });
        stats.fixed++;
      } else if (pid && !validPids[pid]) {
        // product_id 无效且 model 也无法匹配 → 清空无效 product_id
        await db.collection('devices').doc(d._id).update({
          product_id: '',
          updated_at: new Date()
        });
        stats.cleared++;
      } else {
        stats.skipped++;
      }
    }

    res.json({
      msg: '修复完成：✅ 通过 model 重新关联 ' + stats.fixed + ' 台 / 🧹 清空无效 product_id ' + stats.cleared + ' 台 / ⏭ 跳过 ' + stats.skipped + ' 台',
      stats: stats
    });
  } catch (e) { hideError(res, e); }
});

// 发货（严格前置校验 + 订单先落地 + 设备失败回滚订单）
app.post('/api/orders/ship', authRequired, async (req, res) => {
  try {
    const { orderId, tracking_company, tracking_no, deviceId, delivery_type, voucherUrls, voucherTypes } = req.body;

    // ═══════════════════════════════════════════════════════════
    // ① 基础参数校验
    // ═══════════════════════════════════════════════════════════
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });
    var dt = Number(delivery_type) || 0;
    // 面交模式无需物流；邮寄/默认需要
    if (dt !== 1 && (!tracking_company || !tracking_no)) {
      return res.status(400).json({ error: '请完整填写物流信息（快递公司 + 快递单号）' });
    }

    // ═══════════════════════════════════════════════════════════
    // ② 读取订单 — 严格前置状态校验
    // ═══════════════════════════════════════════════════════════
    const doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    var canShip = (Number(order.status) === 3 || order.orderStatus === 'waiting_delivery') &&
      order.orderStatus !== 'waiting_receipt' && order.orderStatus !== 'waiting_admin_review';
    if (!canShip) {
      if (order.orderStatus === 'waiting_receipt' || order.orderStatus === 'waiting_admin_review') {
        return res.status(400).json({ error: '该订单已发货，请勿重复操作' });
      }
      return res.status(400).json({
        error: '订单状态不允许发货，仅待发货(status=3 / orderStatus=waiting_delivery)可操作'
      });
    }

    // ──────────── 双交付方式：面交(1) — 管理员上传凭证并审核通过，直接推进租赁中 ────────────
    if (dt === 1) {
      await db.collection('orders').doc(orderId).update({
        delivery_type_send: 1,
        status: 4,
        orderStatus: 'renting',
        deviceStatus: 'delivered',
        device_id: deviceId || '',
        deviceId: deviceId || '',
        shipped_at: new Date(),
        updated_at: new Date()
      });
      // 保存管理员上传的面交凭证（手持身份证+设备合照）
      if (voucherUrls && Array.isArray(voucherUrls) && voucherUrls.length > 0) {
        try {
          var faceNow = new Date();
          for (var fvi = 0; fvi < voucherUrls.length; fvi++) {
            var voucherType = (voucherTypes && voucherTypes[fvi]) || 'image';
            await db.collection('order_delivery_voucher').add({
              order_id: orderId,
              order_no: order.order_no || orderId,
              node_type: 'send',
              delivery_type: 1,
              voucher_type: voucherType,
              voucher_url: voucherUrls[fvi],
              uploader: 'admin',
              review_status: 'approved',
              review_note: '管理员面交发货时上传',
              reviewed_by: req.adminRole === 'super' ? 'super' : (req.adminSchool || 'branch'),
              reviewed_at: faceNow,
              created_at: faceNow
            });
          }
        } catch (eVoucher) {
          console.error('[ship] 面交凭证保存失败（非阻塞）:', eVoucher.message);
        }
      }
      if (deviceId) {
        try {
          var faceDevDoc = await db.collection('devices').doc(deviceId).get();
          var faceDevice = Array.isArray(faceDevDoc.data) ? faceDevDoc.data[0] : faceDevDoc.data;
          if (faceDevice && (faceDevice.status === '在库' || faceDevice.status === 'available')) {
            await db.collection('devices').doc(deviceId).update({
              status: '租赁中', current_order_id: orderId, updated_at: new Date()
            });
          }
        } catch (e) { /* 不阻塞 */ }
      }
      notifyUser(orderId, 'face_delivery');
      // ★ 微信订单状态同步：发货后异步同步到微信订单管理（不阻塞响应）
      syncWxOrderStatus(order.order_no || orderId);
      return res.json({ msg: '面交发货已完成，订单已进入租赁中' });
    }
    // ⚠️ 从此处开始，任何 return 都不会执行后续状态更新（严格 return 出口）

    // ═══════════════════════════════════════════════════════════
    // ③ 设备可用性校验 + 机型/学校匹配（仅使用中文状态值「在库」「租赁中」）
    // ═══════════════════════════════════════════════════════════
    var deviceCode = '';
    var deviceSerial = '';
    var deviceProductId = '';     // ★ 设备关联的商品ID（用于同步 products.stock）
    var orderProductName = '';    // 订单商品名称 → 匹配 device.model
    var orderSchool = '';         // 订单所属学校 → 匹配 device.school
    if (deviceId) {
      var devDoc = await db.collection('devices').doc(deviceId).get();
      var device = Array.isArray(devDoc.data) ? devDoc.data[0] : devDoc.data;
      if (!device) return res.status(400).json({ error: '设备不存在' });
      deviceProductId = (device.product_id || '').trim();  // ★ 记录设备商品关联

      // ① 状态校验：仅「在库」可发货（兼容旧英文状态 available）
      var devStatus = device.status;
      var isAvailable = (devStatus === '在库' || devStatus === 'available' || !devStatus);
      if (!isAvailable) {
        return res.status(400).json({
          error: '设备当前状态不可租用：' + (devStatus || '未知') + '，仅「在库」设备可发货'
        });
      }

      // ② 机型匹配：设备机型 必须匹配 订单商品名称
      try {
        if (order.items && order.items.length > 0) {
          var pid = order.items[0].product_id;
          if (pid) {
            var prodDoc = await db.collection('products').doc(pid).get();
            var prod = Array.isArray(prodDoc.data) ? prodDoc.data[0] : prodDoc.data;
            orderProductName = (prod && prod.name) ? prod.name.trim() : '';
          }
        }
      } catch (e) { /* 商品查询失败不阻塞，跳过机型校验 */ }
      if (orderProductName && (device.model || '').trim() !== orderProductName) {
        return res.status(400).json({
          error: '设备机型不匹配：订单商品为「' + orderProductName + '」，设备机型为「' + (device.model || '未知') + '」'
        });
      }

      // ③ 学校匹配：设备所属学校 必须匹配 订单所属学校（归一化比较，兼容全称/简称）
      orderSchool = (order.order_source || '').trim();
      if (orderSchool && !isSameSchool(device.school || '', orderSchool)) {
        return res.status(400).json({
          error: '设备所属学校不匹配：订单学校为「' + orderSchool + '」，设备学校为「' + (device.school || '未知') + '」'
        });
      }

      deviceCode = device.deviceCode || device.serial_number || '';
      deviceSerial = device.serial_number || '';
    }

    // ═══════════════════════════════════════════════════════════
    // ④ 先更新订单状态（订单为核心数据，先落地）
    // dt===2 邮寄新流程：主状态保持待发货，子状态标记待客户收货确认
    // dt===0 默认流程（向后兼容）：直接进入租赁中
    // ═══════════════════════════════════════════════════════════
    var isNewMailFlow = (dt === 2);
    var orderUpdateData = {
      delivery_type_send: dt || 2,
      tracking_company: tracking_company,
      tracking_no: tracking_no,
      device_sn: deviceCode,
      device_id: deviceId || '',
      deviceCode: deviceCode,
      deviceId: deviceId || '',
      shipped_at: new Date(),
      updated_at: new Date()
    };
    if (isNewMailFlow) {
      orderUpdateData.orderStatus = 'waiting_receipt';
      orderUpdateData.deviceStatus = 'delivered';
    } else {
      orderUpdateData.status = 4;
      orderUpdateData.orderStatus = 'renting';
      orderUpdateData.deviceStatus = 'delivered';
    }
    await db.collection('orders').doc(orderId).update(orderUpdateData);

    // ④½ 保存管理员上传的发货凭证（邮寄模式）
    if (isNewMailFlow && voucherUrls && Array.isArray(voucherUrls) && voucherUrls.length > 0) {
      try {
        var vNow = new Date();
        for (var vi = 0; vi < voucherUrls.length; vi++) {
          var voucherTypeMail = (voucherTypes && voucherTypes[vi]) || 'image';
          await db.collection('order_delivery_voucher').add({
            order_id: orderId,
            order_no: order.order_no || orderId,
            node_type: 'send',
            delivery_type: 2,
            voucher_type: voucherTypeMail,
            voucher_url: voucherUrls[vi],
            uploader: 'admin',
            review_status: 'approved',
            review_note: '管理员发货时上传',
            reviewed_by: req.adminRole === 'super' ? 'super' : (req.adminSchool || 'branch'),
            reviewed_at: vNow,
            created_at: vNow
          });
        }
      } catch (eVoucher) {
        console.error('[ship] 发货凭证保存失败（非阻塞）:', eVoucher.message);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // ⑤ 并发校验 + 更新设备状态为「租赁中」（失败则回滚订单）
    // ═══════════════════════════════════════════════════════════
    if (deviceId) {
      try {
        // 并发校验：二次确认设备仍为「在库」，防止同一设备被多笔订单同时占用
        var recheckDoc = await db.collection('devices').doc(deviceId).get();
        var recheckDevice = Array.isArray(recheckDoc.data) ? recheckDoc.data[0] : recheckDoc.data;
        var recheckOk = recheckDevice && (recheckDevice.status === '在库' || recheckDevice.status === 'available');
        if (!recheckOk) {
          // 设备已被其他订单占用 → 回滚订单
          console.error('[ship] ⚠️ 并发冲突：设备 ' + deviceId + ' 已非在库状态，当前=' + (recheckDevice && recheckDevice.status));
          var conflictRollback = {
            status: order.status,
            orderStatus: order.orderStatus || 'waiting_delivery',
            deviceStatus: order.deviceStatus || null,
            device_sn: order.device_sn || '',
            device_id: order.device_id || '',
            deviceCode: order.deviceCode || '',
            deviceId: order.deviceId || '',
            tracking_company: order.tracking_company || '',
            tracking_no: order.tracking_no || '',
            shipped_at: order.shipped_at || null,
            delivery_type_send: order.delivery_type_send || 0,
            updated_at: new Date()
          };
          await db.collection('orders').doc(orderId).update(conflictRollback).catch(function(rbErr) {
            console.error('[ship] ⚠️ 并发回滚订单失败，需人工处理 orderId=' + orderId, rbErr.message);
          });
          return res.status(409).json({ error: '设备「' + deviceSerial + '」已被其他订单占用，请重新选择设备' });
        }

        // 并发校验通过 → 更新设备为「租赁中」
        await db.collection('devices').doc(deviceId).update({
          status: '租赁中',
          current_order_id: orderId,
          updated_at: new Date()
        });
        // ★ 同步扣减 products.stock（与设备表保持一致）
        if (deviceProductId) {
          try {
            await db.collection('products').doc(deviceProductId).update({
              data: { stock: _.inc(-1), updated_at: new Date() }
            });
            console.log('[ship] products.stock -1 for productId=' + deviceProductId);
          } catch (eStock) {
            console.warn('[ship] products.stock 扣减失败（非阻塞）:', eStock.message);
          }
        }
      } catch (deviceErr) {
        // 设备更新失败 → 回滚订单到待发货状态，杜绝脏数据
        console.error('[ship] 设备状态更新失败，回滚订单 orderId=' + orderId, deviceErr.message);
        var rollbackData = {
          status: order.status,
          orderStatus: order.orderStatus || 'waiting_delivery',
          deviceStatus: order.deviceStatus || null,
          device_sn: order.device_sn || '',
          device_id: order.device_id || '',
          deviceCode: order.deviceCode || '',
          deviceId: order.deviceId || '',
          tracking_company: order.tracking_company || '',
          tracking_no: order.tracking_no || '',
          shipped_at: order.shipped_at || null,
          updated_at: new Date()
        };
        await db.collection('orders').doc(orderId).update(rollbackData).catch(function(rbErr) {
          console.error('[ship] ⚠️ 回滚订单失败，需人工处理 orderId=' + orderId, rbErr.message);
        });
        return res.status(500).json({ error: '设备状态更新失败，订单已回滚至待发货：' + deviceErr.message });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // ⑥ 异步通知（不阻塞响应）
    // ═══════════════════════════════════════════════════════════
    notifyUser(orderId, 'shipped');

    // ★ 微信订单状态同步：发货后异步同步到微信订单管理（不阻塞响应）
    syncWxOrderStatus(order.order_no || orderId);

    res.json({ msg: '发货成功' + (deviceSerial ? '（设备：' + deviceSerial + '）' : '') + (isNewMailFlow ? '｜子状态：待客户收货确认' : '') });
  } catch (e) { hideError(res, e); }
});

// 商品列表
app.get('/api/products', authRequired, async (req, res) => {
  try {
    const { data: list } = await db.collection('products').orderBy('created_at', 'desc').get();
    var products = Array.isArray(list) ? list : [];

    // ═══════════════════════════════════════════════════════════════
    // 库存从设备表实时聚合 — 双通道匹配（product_id 优先，model 兜底）
    // ═══════════════════════════════════════════════════════════════
    // 建立 product._id → stock 和 product.name → stock 两套索引
    var stockByProductId = {};   // device.product_id → count
    var stockByModel = {};       // device.model → count（兜底）
    try {
      var devBatchSize = 500;
      var devCursor = 0;
      var devHasMore = true;
      while (devHasMore) {
        var { data: devBatch } = await db.collection('devices').skip(devCursor).limit(devBatchSize).get();
        devBatch = Array.isArray(devBatch) ? devBatch : [];
        if (devBatch.length === 0) { devHasMore = false; break; }
        devBatch.forEach(function(d) {
          // ★ 仅「在库」可出租；租赁中/其他平台租赁中/维修中均不计数
          var isAvailable = d.status === '在库' || d.status === 'available' || !d.status;
          // 明确排除不可出租状态
          if (d.status === '租赁中' || d.status === '其他平台租赁中' ||
              d.status === 'rented' || d.status === '在租' ||
              d.status === '维修中' || d.status === 'maintenance') {
            return;
          }
          if (!isAvailable) return;

          // 通道 1：product_id 精确匹配（最可靠）
          var pid = (d.product_id || '').trim();
          if (pid) stockByProductId[pid] = (stockByProductId[pid] || 0) + 1;

          // 通道 2：model 文本匹配（兜底，兼容未设 product_id 的旧设备）
          var model = (d.model || '').trim();
          if (model) stockByModel[model] = (stockByModel[model] || 0) + 1;
        });
        devCursor += devBatchSize;
        if (devBatch.length < devBatchSize) devHasMore = false;
      }
    } catch (e) {
      console.error('[products] 设备库存聚合失败:', e.message);
    }

    // 为每个商品计算库存：product_id 匹配优先，model 匹配兜底
    products.forEach(function(p) {
      var pid = (p._id || '').trim();
      var pname = (p.name || '').trim();
      // 取两者中较大值（product_id 匹配通常等于 model 匹配，取大值防漏）
      var countById = stockByProductId[pid] || 0;
      var countByModel = stockByModel[pname] || 0;
      p.stock = Math.max(countById, countByModel);
    });

    res.json({ list: products });
  } catch (e) { hideError(res, e); }
});

// 按学校统计库存（从设备表聚合）
app.get('/api/products/stock-by-branch', authRequired, async (req, res) => {
  try {
    var { productId } = req.query;
    if (!productId) return res.status(400).json({ error: '缺少 productId 参数' });

    // 15 秒超时竞速：云函数慢/未部署时返回降级数据，防止前端永久 loading
    var timeoutPromise = new Promise(function(resolve) {
      setTimeout(function() {
        resolve({ _timeout: true });
      }, 15000);
    });
    var callPromise = tcb.callFunction({
      name: 'getProductStockByBranch',
      data: { action: 'byProduct', productId: productId }
    });
    var result = await Promise.race([callPromise, timeoutPromise]);

    if (result && result._timeout) {
      console.error('[stock-by-branch] 云函数调用超时（15s），可能未部署或响应过慢');
      return res.status(504).json({ error: '云函数响应超时，请确认 getProductStockByBranch 已在微信开发者工具中上传部署' });
    }

    var data = (result && result.result) || {};
    if (data && data.code === 0 && data.data) {
      res.json({
        stockList: data.data.stockList || [],
        summaryList: data.data.summaryList || []
      });
    } else {
      console.error('[stock-by-branch] 云函数返回异常:', JSON.stringify(data).substring(0, 300));
      res.status(500).json({ error: (data && data.msg) || '云函数返回异常，请检查 getProductStockByBranch 是否已部署' });
    }
  } catch (e) {
    console.error('[stock-by-branch] 调用失败:', e.message);
    res.status(500).json({ error: '查询库存分布失败：' + (e.message || '未知错误') + '。请确认 getProductStockByBranch 云函数已部署。' });
  }
});

// 上下架
app.post('/api/products/toggle', authRequired, async (req, res) => {
  try {
    const { productId } = req.body;
    const doc = await db.collection('products').doc(productId).get();
    var prod = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!prod) return res.status(400).json({ error: '商品不存在' });
    const newStatus = prod.status === 1 ? 0 : 1;
    await db.collection('products').doc(productId).update({ status: newStatus, updated_at: new Date() });
    res.json({ msg: newStatus === 1 ? '已上架' : '已下架', status: newStatus });
  } catch (e) { hideError(res, e); }
});

// 保存商品（新增/编辑）— 库存由设备管理自动计算，不可手动设置
app.post('/api/products/save', authRequired, async (req, res) => {
  try {
    const { productId, name, daily_price, original_deposit, stock, category_id, description, tags, images, price_3d, price_7d, price_14d, price_30d, price_60d, price_90d, carousel_img, laser_insurance, insurance_list } = req.body;
    if (!name || daily_price == null) return res.status(400).json({ error: '名称和日租价必填' });
    if (Number(daily_price) <= 0) return res.status(400).json({ error: '日租价必须大于0' });
    const data = {
      name, daily_price: Number(daily_price),
      original_deposit: Math.max(0, Number(original_deposit || 0)),
      price_3d: price_3d != null ? Number(price_3d) : undefined,
      price_7d: price_7d != null ? Number(price_7d) : undefined,
      price_14d: price_14d != null ? Number(price_14d) : undefined,
      price_30d: price_30d != null ? Number(price_30d) : undefined,
      price_60d: price_60d != null ? Number(price_60d) : undefined,
      price_90d: price_90d != null ? Number(price_90d) : undefined,
      laser_insurance: laser_insurance || '',
      category_id: Number(category_id || 1),
      description: description || '', tags: tags || '',
      updated_at: new Date()
    };
    // ⚠️ stock 由 GET /api/products 从设备表实时聚合，不接受手动写入
    // 仅新建商品时设初始库存为 0，后续由 ship/return-verify/cancel 自动同步
    if (!productId) {
      data.stock = 0;  // ★ 新商品初始库存为 0（实际库存由设备状态决定）
    }
    if (images) {
      data.images = (typeof images === 'string' ? JSON.parse(images) : images);
    }
    if (carousel_img !== undefined) {
      data.carousel_img = (typeof carousel_img === 'string' ? JSON.parse(carousel_img) : carousel_img);
    }
    if (insurance_list !== undefined) {
      data.insurance_list = (typeof insurance_list === 'string' ? JSON.parse(insurance_list) : insurance_list);
    }

    var newProductId = '';
    if (productId) {
      await db.collection('products').doc(productId).update(data);
    } else {
      data.status = 1;
      data.created_at = new Date();
      var addResult = await db.collection('products').add(data);
      newProductId = (addResult && addResult.id) || '';
    }
    res.json({ msg: productId ? '已更新' : '已添加', productId: productId || newProductId });
  } catch (e) { hideError(res, e); }
});

// 获取云存储图片的临时下载链接（用于网页预览）
app.post('/api/products/images', authRequired, async (req, res) => {
  try {
    var { fileList } = req.body;
    if (!fileList || !fileList.length) return res.json({ urls: [] });

    // 去重
    var uniqueFiles = [];
    var seen = {};
    fileList.forEach(function(f) {
      if (f && !seen[f]) { seen[f] = true; uniqueFiles.push(f); }
    });

    // 分批（单次最多50），收集 temp URL
    var urlMap = {};
    var batchSize = 50;
    for (var i = 0; i < uniqueFiles.length; i += batchSize) {
      var batch = uniqueFiles.slice(i, i + batchSize);
      try {
        var result = await tcb.getTempFileURL({ fileList: batch });
        (result.fileList || []).forEach(function(item, idx) {
          console.log('[images] #' + (i + idx) + ' fileID=' + (item.fileID || '').substring(0, 50) + ' tempURL=' + ((item.tempFileURL || 'EMPTY').substring(0, 80)) + ' code=' + (item.code || 'OK'));
          if (item.tempFileURL) {
            urlMap[batch[idx]] = item.tempFileURL;
          } else {
            urlMap[batch[idx]] = batch[idx]; // 保留原 fileID
          }
        });
      } catch (e) {
        console.error('[images] batch error:', e.message);
        batch.forEach(function(f) { urlMap[f] = f; });
      }
    }

    var urls = fileList.map(function(f) { return urlMap[f] || f || ''; });
    res.json({ urls });
  } catch (e) { hideError(res, e); }
});

// ==================== 轮播图管理 ====================

// 轮播图列表
app.get('/api/banners', authRequired, async (req, res) => {
  try {
    const { data: list } = await db.collection('banners').orderBy('sort', 'asc').get();
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// 保存轮播图（新增/编辑）
app.post('/api/banners/save', authRequired, async (req, res) => {
  try {
    const { bannerId, image_url, title, sort, link } = req.body;
    if (!image_url) return res.status(400).json({ error: '请上传图片' });
    const data = {
      image_url, title: title || '', sort: Number(sort || 0),
      link: link || '', updated_at: new Date()
    };
    if (bannerId) {
      await db.collection('banners').doc(bannerId).update(data);
    } else {
      data.status = 1;
      data.created_at = new Date();
      await db.collection('banners').add(data);
    }
    res.json({ msg: bannerId ? '已更新' : '已添加' });
  } catch (e) { hideError(res, e); }
});

// 切换轮播图状态
app.post('/api/banners/toggle', authRequired, async (req, res) => {
  try {
    const { bannerId } = req.body;
    const doc = await db.collection('banners').doc(bannerId).get();
    var b = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!b) return res.status(400).json({ error: '轮播图不存在' });
    const newStatus = b.status === 1 ? 0 : 1;
    await db.collection('banners').doc(bannerId).update({ status: newStatus, updated_at: new Date() });
    res.json({ msg: newStatus === 1 ? '已启用' : '已禁用', status: newStatus });
  } catch (e) { hideError(res, e); }
});

// 删除轮播图
app.post('/api/banners/delete', authRequired, async (req, res) => {
  try {
    const { bannerId } = req.body;
    await db.collection('banners').doc(bannerId).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// 图片上传到云存储
app.post('/api/upload', authRequired, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请选择文件（未检测到上传文件，请确认文件字段名为 files）' });
    }
    const urls = [];
    for (const file of req.files) {
      const ext = file.originalname.split('.').pop() || 'jpg';
      const cloudPath = 'product-images/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      const result = await tcb.uploadFile({ cloudPath, fileContent: file.buffer });
      urls.push(result.fileID);
    }
    // ★ 同时返回临时链接供前端预览（cloud:// 无法直接在浏览器显示）
    var tempUrls = [];
    try {
      var tempRes = await tcb.getTempFileURL({ fileList: urls });
      tempUrls = (tempRes.fileList || []).map(function(item) { return item.tempFileURL || ''; });
    } catch (e) { /* 临时链接获取失败不阻塞上传 */ }
    res.json({ urls: urls, tempUrls: tempUrls });
  } catch (e) { hideError(res, e); }
});

// ==================== 押金退还 ====================
app.post('/api/orders/refund-deposit', authRequired, async (req, res) => {
  try {
    var { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });

    var doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });
    // 兼容新旧状态：旧 status===5（已完成）或新 orderStatus==='completed'
    var canRefund = Number(order.status) === 5 || order.orderStatus === 'completed';
    if (!canRefund) return res.status(400).json({ error: '仅已完成订单可退还押金' });
    if (order.deposit_refunded) return res.status(400).json({ error: '押金已退还' });

    // 统一以 actual_deposit 为准，兼容旧订单（无 actual_deposit 字段时自动计算）
    var baseDeposit = parseFloat(order.final_deposit || order.estimated_deposit || 0);
    var damageFee = parseFloat(order.damage_fee || 0);
    var actualDeposit = order.actual_deposit;
    if (actualDeposit === undefined || actualDeposit === null) {
      actualDeposit = Math.max(0, +(baseDeposit - damageFee).toFixed(2));
    }
    var refundAmount = parseFloat(actualDeposit);

    await db.collection('orders').doc(orderId).update({
      deposit_refunded: true,
      deposit_refund_amount: refundAmount,
      actual_deposit: actualDeposit,
      deposit_refunded_at: new Date(),
      updated_at: new Date()
    });

    if (refundAmount <= 0) {
      res.json({ msg: '押金无需退还（损坏扣款已抵扣全部押金）' });
    } else {
      notifyUser(orderId, 'deposit_refunded');
      res.json({ msg: '押金已退还 ¥' + refundAmount.toFixed(2) });
    }
  } catch (e) { hideError(res, e); }
});

// 押金退还列表
app.get('/api/orders/pending-refund', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可处理押金退还' });
    var { data: list } = await db.collection('orders').where({
      status: 5
    }).orderBy('updated_at', 'desc').get();
    list = Array.isArray(list) ? list : [];
    // 在服务端过滤：deposit_refunded 不为 true（含字段不存在的情况）
    list = list.filter(function(o) { return !o.deposit_refunded; });
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// ==================== 理赔管理 ====================
app.get('/api/claims', authRequired, async (req, res) => {
  try {
    var { status, apply_type } = req.query;
    var where = {};
    if (status) where.status = Number(status);
    else where.status = _.in([2, 3, 4]); // 默认显示理赔相关状态
    if (apply_type) where.apply_type = apply_type; // 筛选申请类型：damage / refund

    var { data: list } = await db.collection('order_insurances').where(where)
      .orderBy('claimed_at', 'desc').get();
    list = Array.isArray(list) ? list : [];

    // 补充订单和用户信息，并对分点管理员过滤
    for (var c of list) {
      try {
        var { data: orders } = await db.collection('orders').doc(c.order_id).get();
        var ol = Array.isArray(orders) ? orders : (orders ? [orders] : []);
        c.order_no = ol.length > 0 ? (ol[0].order_no || c.order_id) : c.order_id;
        c.user_openid = ol.length > 0 ? ol[0]._openid : '';
        // 记录订单归属用于过滤
        c._orderSchoolId = ol.length > 0 ? (ol[0].schoolId || ol[0].branchId || '') : '';
        c._orderSource = ol.length > 0 ? (ol[0].order_source || '') : '';
      } catch (e) { c.order_no = c.order_id; }
      if (c.user_openid) {
        try {
          var { data: users } = await db.collection('users').where({ _openid: c.user_openid }).get();
          var ul = Array.isArray(users) ? users : (users ? [users] : []);
          c.user_nickname = ul.length > 0 ? (ul[0].nickname || '匿名') : '匿名';
        } catch (e) { c.user_nickname = '匿名'; }
      }
    }

    // 分点管理员只能看自己分点的理赔
    if (req.adminRole === 'branch') {
      var branchId = req.adminBranchId || '';
      var school = req.adminSchool || '';
      list = list.filter(function(c) {
        if (branchId && c._orderSchoolId === branchId) return true;
        if (school && c._orderSource === school) return true;
        return false;
      });
    }

    res.json({ list });
  } catch (e) { hideError(res, e); }
});

app.post('/api/claims/process', authRequired, async (req, res) => {
  try {
    // 仅总号可处理理赔
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可处理理赔' });
    var { claimId, action, rejectReason } = req.body;
    if (!claimId || !action) return res.status(400).json({ error: '缺少参数' });

    var doc = await db.collection('order_insurances').doc(claimId).get();
    var claim = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!claim) return res.status(400).json({ error: '理赔记录不存在' });
    if (claim.status !== 2) return res.status(400).json({ error: '该理赔已处理' });

    // ═══════════════════════════════════════════════════════════
    // 损坏理赔 — 审核通过后同步更新订单 damage_fee + actual_deposit
    // ═══════════════════════════════════════════════════════════
    if (claim.apply_type !== 'refund') {
      if (action === 'approve') {
        // ① 更新理赔记录状态
        await db.collection('order_insurances').doc(claimId).update({
          status: 3, reviewed_at: new Date()
        });
        // ② 如果传入了扣款金额，同步更新订单 damage_fee（累加）+ actual_deposit
        var damageFeeVal = parseFloat(req.body.damageFee);
        if (!isNaN(damageFeeVal) && damageFeeVal > 0) {
          try {
            var claimOrderDoc = await db.collection('orders').doc(claim.order_id).get();
            var claimOrder = Array.isArray(claimOrderDoc.data) ? claimOrderDoc.data[0] : claimOrderDoc.data;
            if (claimOrder) {
              var existingDamage = parseFloat(claimOrder.damage_fee || 0);
              var totalDamage = +(existingDamage + damageFeeVal).toFixed(2);
              var baseDeposit = parseFloat(claimOrder.final_deposit || claimOrder.estimated_deposit || 0);
              var actualDeposit = Math.max(0, +(baseDeposit - totalDamage).toFixed(2));
              var damageNote = (claimOrder.damage_note || '') +
                (claimOrder.damage_note ? '；' : '') +
                '[理赔] ' + (claim.claim_reason || '') + '（扣款 ¥' + damageFeeVal + '）';
              await db.collection('orders').doc(claim.order_id).update({
                damage_fee: totalDamage,
                damage_note: damageNote,
                actual_deposit: actualDeposit,
                claim_status: 'processed',
                updated_at: new Date()
              });
              res.json({ msg: '理赔已通过，已扣款 ¥' + damageFeeVal.toFixed(2) + '，实际押金 ¥' + actualDeposit.toFixed(2) });
              return;
            }
          } catch (eOrder) {
            console.error('[claims] 同步订单扣款失败 orderId=' + claim.order_id, eOrder.message);
          }
        }
        res.json({ msg: '理赔已通过' });
      } else if (action === 'reject') {
        await db.collection('order_insurances').doc(claimId).update({
          status: 4, reject_reason: rejectReason || '不符合理赔条件', reviewed_at: new Date()
        });
        res.json({ msg: '理赔已拒绝' });
      } else {
        res.status(400).json({ error: '无效操作' });
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // 订单退款审核 — 含微信原路退款 + 订单状态联动 + 设备释放
    // ═══════════════════════════════════════════════════════════

    // ① 驳回：只需更新状态，无资金操作
    if (action === 'reject') {
      await db.collection('order_insurances').doc(claimId).update({
        status: 4, reject_reason: rejectReason || '不符合退款条件', reviewed_at: new Date()
      });
      await db.collection('orders').doc(claim.order_id).update({
        refund_status: 'rejected',
        refund_reviewed_at: new Date(),
        updated_at: new Date()
      }).catch(function(e) {
        console.error('[claims] 更新订单退款状态失败 orderId=' + claim.order_id, e.message);
      });
      res.json({ msg: '退款已拒绝' });
      return;
    }

    // 安全阀：非明确批准一律拒绝，防止意外穿透到微信退款
    if (action !== 'approve') {
      return res.status(400).json({ error: '无效操作，仅支持 approve 或 reject' });
    }

    // ② 批准 → 加载完整订单数据
    var orderDoc = await db.collection('orders').doc(claim.order_id).get();
    var order = Array.isArray(orderDoc.data) ? orderDoc.data[0] : orderDoc.data;
    if (!order) return res.status(400).json({ error: '关联订单不存在' });

    // ③ 确定退款金额（默认 = 订单总租金，后台可手动调整 refund_amount）
    var refundAmount = claim.refund_amount || order.total_rent || 0;
    if (parseFloat(refundAmount) <= 0) {
      return res.status(400).json({ error: '退款金额无效（refund_amount=' + refundAmount + '）' });
    }

    // ④ 调用微信支付原路退款（成功 / 未配置凭证 / 失败）
    var outRefundNo = 'RF' + (order.order_no || order._id) + '_' + Date.now();
    var refundResult = await refundWechatPay(order, refundAmount, outRefundNo);

    // 微信退款失败（含凭证未配置）→ 不更新任何状态，杜绝脏数据
    if (!refundResult.success) {
      console.error('[claims] 微信退款失败 out_trade_no=' + order.order_no, refundResult.error);
      return res.status(500).json({ error: '微信退款失败：' + refundResult.error + '（订单状态未变更，请重试）' });
    }

    // ⑤ 根据订单原状态决定目标状态
    var originalStatus = Number(order.status);
    var targetStatus, targetOrderStatus;
    if (originalStatus === 3) {
      // 待发货 → 已取消（设备未出库，直接释放）
      targetStatus = 0;
      targetOrderStatus = 'cancelled';
    } else if (originalStatus === 4) {
      // 租赁中 → 已完成（标记已退款）
      targetStatus = 5;
      targetOrderStatus = 'completed';
    } else {
      // 其他状态不修改主状态（仅标记退款）
      targetStatus = originalStatus;
      targetOrderStatus = order.orderStatus || '';
    }

    // ⑥ 更新理赔记录（记录微信退款流水）
    await db.collection('order_insurances').doc(claimId).update({
      status: 3,
      refund_amount: refundAmount,
      wechat_refund_id: refundResult.refund_id || '',
      refunded_at: new Date(),
      reviewed_at: new Date()
    });

    // ⑦ 更新订单状态（主状态 + 退款标记 + 微信退款流水）
    var orderUpdateData = {
      status: targetStatus,
      orderStatus: targetOrderStatus,
      refund_status: 'approved',
      refund_amount: refundAmount,
      wechat_refund_id: refundResult.refund_id || '',
      refunded_at: new Date(),
      refund_reviewed_at: new Date(),
      updated_at: new Date()
    };
    // 如果是取消，补取消时间
    if (targetStatus === 0) {
      orderUpdateData.cancelled_at = new Date();
    }
    await db.collection('orders').doc(claim.order_id).update(orderUpdateData);

    // ⑧ 释放设备回空闲状态（中文状态值「在库」）
    var deviceId = order.deviceId || order.device_id || '';
    if (deviceId) {
      try {
        await db.collection('devices').doc(deviceId).update({
          status: '在库',
          current_order_id: '',
          updated_at: new Date()
        });
        console.log('[claims] 设备已释放 deviceId=' + deviceId);
      } catch (e) {
        console.error('[claims] 设备释放失败 deviceId=' + deviceId, e.message);
        // 设备释放失败不回滚（订单状态已正确更新）
      }
    }

    // ⑨ 异步通知用户
    notifyUser(claim.order_id, 'refund_approved');

    res.json({
      msg: '退款已通过（¥' + refundAmount + '），资金已原路返还' +
        (targetStatus !== originalStatus ? '，订单已' + (targetStatus === 0 ? '取消' : '完成') : '')
    });
  } catch (e) {
    console.error('[claims] 退款审核异常:', e.message, e.stack || '');
    res.status(500).json({ error: '审核处理失败：' + e.message });
  }
});

// ==================== 评价管理 ====================
app.get('/api/reviews', authRequired, async (req, res) => {
  try {
    var page = Number(req.query.page) || 1;
    var pageSize = Number(req.query.pageSize) || 20;
    var { data: list } = await db.collection('reviews')
      .skip((page - 1) * pageSize).limit(pageSize)
      .orderBy('created_at', 'desc').get();
    var { total } = await db.collection('reviews').count();

    // 补充用户昵称和商品名称
    for (var r of list) {
      try {
        var { data: users } = await db.collection('users').where({ _openid: r._openid }).get();
        var ul = Array.isArray(users) ? users : (users ? [users] : []);
        r.user_nickname = ul.length > 0 ? (ul[0].nickname || '匿名用户') : '匿名用户';
      } catch (e) { r.user_nickname = '匿名用户'; }
      try {
        var { data: prods } = await db.collection('products').doc(r.product_id).get();
        var pl = Array.isArray(prods) ? prods : (prods ? [prods] : []);
        r.product_name = pl.length > 0 ? pl[0].name : '已下架商品';
      } catch (e) { r.product_name = '已下架商品'; }
    }

    res.json({ list, total, page, pageSize });
  } catch (e) { hideError(res, e); }
});

// ==================== 数据导出 ====================

// 共享 CSV 生成函数 — 可供手动导出和自动导出复用
// 参数:
//   options.status   - 订单状态过滤（如 5 表示已完成）
//   options.source   - 订单来源过滤（可选）
//   options.role     - 管理员角色 'super' | 'branch'
//   options.school   - 分校管理员所属学校
// 返回: { csv: String, orderCount: Number }
async function generateOrdersCSV(options) {
  var exWhere = {};
  if (options.role === 'branch' && options.school) {
    exWhere.order_source = options.school;
  } else if (options.source && options.source !== '__other__') {
    exWhere.order_source = options.source;
  }
  if (options.status) exWhere.status = Number(options.status);

  var { data: list } = await db.collection('orders').where(exWhere)
    .orderBy('created_at', 'desc').limit(5000).get();
  list = Array.isArray(list) ? list : [];

  function fmt(d) {
    if (!d) return '';
    var dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d).substring(0, 10);
    return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0') + ' ' + String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
  }
  var statusMap = {0:'已取消',1:'待审核押金',2:'待付款',3:'待发货',4:'租赁中',5:'已完成',6:'待归还验收'};
  var rows = [['单号','商品','天数','租金','押金','保障','损坏扣款','优惠券','来源','对接人','设备序列号','状态','收货人','电话','地址','下单时间','完成时间']];
  for (var o of list) {
    var items = (o.items||[]).map(function(i){ return i.product_name; }).join('/');
    var insTotal = 0;
    try {
      var { data: ins } = await db.collection('order_insurances').where({ order_id: o._id }).get();
      (Array.isArray(ins)?ins:[]).forEach(function(i){ insTotal += parseFloat(i.price||0); });
    } catch(e){}
    var addr = o.address_snapshot || {};
    rows.push([
      o.order_no || o._id,
      items,
      (o.items&&o.items[0]?o.items[0].rental_days:'') + '天',
      o.total_rent || 0,
      o.final_deposit || o.estimated_deposit || 0,
      insTotal.toFixed(2),
      o.damage_fee || 0,
      o.coupon_info ? o.coupon_info.name : '',
      o.order_source || '',
      o.order_contact_person || '',
      o.device_sn || '',
      statusMap[o.status]||'',
      addr.name||'',
      addr.phone||'',
      (addr.province||'')+(addr.city||'')+(addr.district||'')+' '+(addr.detail||''),
      fmt(o.created_at),
      fmt(o.updated_at)
    ]);
  }

  var csv = '﻿' + rows.map(function(r){ return r.map(function(c){ return '"' + String(c).replace(/"/g,'""') + '"'; }).join(','); }).join('\n');
  return { csv: csv, orderCount: list.length };
}

app.get('/api/orders/export', authRequired, async (req, res) => {
  try {
    var { csv } = await generateOrdersCSV({
      status: req.query.status,
      source: req.query.source,
      role: req.adminRole || 'super',
      school: req.adminSchool || ''
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=orders_' + new Date().toISOString().slice(0,10) + '.csv');
    res.send(csv);
  } catch (e) { hideError(res, e); }
});

// ==================== 风控查询 ====================
app.get('/api/risk-records', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可查看风控记录' });
    var { targetId } = req.query;
    var where = {};
    if (targetId) where.target_id = targetId;
    var { data: list } = await db.collection('risk_records').where(where)
      .orderBy('created_at', 'desc').limit(50).get();
    list = Array.isArray(list) ? list : [];
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// 代理调用风控接口（从后台发起）
app.post('/api/risk-query', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可进行风控查询' });
    var { action, queryType, queryValue, telephone, idcardno, name } = req.body;
    // authUrl 不需要其他参数
    if (action === 'authUrl') {
      var callRes = await tcb.callFunction({ name: 'riskQuery', data: { action: 'authUrl' } });
      res.json(callRes.result || {});
      return;
    }
    if (!action || !queryType || !queryValue) return res.status(400).json({ error: '缺少参数' });
    var extra = { telephone, idcardno, name };
    if (!extra.telephone && queryType === 'phone') extra.telephone = queryValue;
    if (!extra.idcardno && queryType === 'idcard') extra.idcardno = queryValue;
    if (!extra.name && queryType === 'name') extra.name = queryValue;
    var callRes = await tcb.callFunction({
      name: 'riskQuery',
      data: { action, queryType, queryValue, targetType: 'admin_manual', ...extra }
    });
    res.json(callRes.result || {});
  } catch (e) { hideError(res, e); }
});

// ==================== 用户管理 ====================

// 用户列表（含详细信息）
app.get('/api/users', authRequired, async (req, res) => {
  try {
    var page = Number(req.query.page) || 1;
    var pageSize = Number(req.query.pageSize) || 20;
    var keyword = req.query.keyword || '';
    var authStatus = req.query.authStatus;
    var hasPhone = req.query.hasPhone;
    var minExp = Number(req.query.minExp) || 0;
    var maxExp = Number(req.query.maxExp);
    var memberLevel = req.query.memberLevel || '';

    // 会员等级 → 经验范围映射
    var LEVEL_RANGES = { 'normal': [0, 199], 'silver': [200, 499], 'gold': [500, 999], 'diamond': [1000, Infinity] };

    var conditions = [];
    // 认证状态筛选
    if (authStatus !== undefined && authStatus !== '') {
      conditions.push({ auth_status: Number(authStatus) });
    }
    // 手机号筛选
    if (hasPhone === 'true') {
      conditions.push({ phone: _.and(_.exists(true), _.neq('')) });
    } else if (hasPhone === 'false') {
      conditions.push(_.or([{ phone: _.exists(false) }, { phone: '' }]));
    }
    // 会员等级筛选（转换为经验范围）
    if (memberLevel && LEVEL_RANGES[memberLevel]) {
      var range = LEVEL_RANGES[memberLevel];
      if (memberLevel === 'normal') {
        // 普通会员：exp 不存在或 0-199（兼容历史用户无 exp 字段）
        conditions.push(_.or([{ exp: _.exists(false) }, { exp: _.lte(range[1]) }]));
      } else {
        if (range[0] > 0) conditions.push({ exp: _.gte(range[0]) });
        if (range[1] < Infinity) conditions.push({ exp: _.lte(range[1]) });
      }
    }
    // 经验范围筛选
    if (minExp > 0) conditions.push({ exp: _.gte(minExp) });
    if (maxExp && maxExp < Infinity) conditions.push({ exp: _.lte(maxExp) });
    // 关键词搜索
    if (keyword) {
      conditions.push(_.or([
        { nickname: db.RegExp({ regexp: keyword, options: 'i' }) },
        { phone: db.RegExp({ regexp: keyword, options: 'i' }) }
      ]));
    }

    var where = conditions.length > 0 ? _.and(conditions) : {};

    var totalRes = await db.collection('users').where(where).count();
    var listRes = await db.collection('users').where(where)
      .skip((page - 1) * pageSize).limit(pageSize)
      .orderBy('created_at', 'desc').get();

    // 增强：为每个用户附加微信绑定数量和合并状态
    var enhancedList = [];
    for (var user of (listRes.data || [])) {
      var enhanced = Object.assign({}, user);

      // 微信绑定数量
      try {
        var bindCount = await db.collection('wechat_bindings').where({ user_id: user._id }).count();
        enhanced.wechat_bind_count = bindCount.total || 0;
      } catch (e) { enhanced.wechat_bind_count = 0; }

      // 订单数量（orders 集合用 _openid 关联用户）
      try {
        var orderCount = await db.collection('orders').where({ _openid: user._openid }).count();
        enhanced.order_count = orderCount.total || 0;
      } catch (e) { enhanced.order_count = 0; }

      // 合并状态
      enhanced.is_merged = !!user.merged_into;
      enhanced.merged_into_id = user.merged_into || null;

      enhancedList.push(enhanced);
    }

    res.json({ list: enhancedList, total: totalRes.total, page: page, pageSize: pageSize });
  } catch (e) { hideError(res, e); }
});

// 用户详情
app.get('/api/users/:id', authRequired, async (req, res) => {
  try {
    var userId = req.params.id;
    var userDoc;
    try {
      userDoc = await db.collection('users').doc(userId).get();
    } catch (e) {
      return res.status(404).json({ error: '用户不存在' });
    }
    var users = Array.isArray(userDoc.data) ? userDoc.data : (userDoc.data ? [userDoc.data] : []);
    if (users.length === 0) return res.status(404).json({ error: '用户不存在' });
    var u = users[0];

    // 微信绑定
    var bindings = [];
    try {
      var bindRes = await db.collection('wechat_bindings').where({ user_id: userId }).get();
      bindings = Array.isArray(bindRes.data) ? bindRes.data : [];
    } catch (e) { /* 集合可能不存在 */ }

    // 最近订单（orders 集合用 _openid 关联用户）
    var orders = [];
    var orderStatusMap = {0:'已取消',1:'待审核押金',2:'待付款',3:'待发货',4:'租赁中',5:'已完成',6:'待归还验收'};
    try {
      var orderRes = await db.collection('orders').where({ _openid: u._openid || '' })
        .orderBy('created_at', 'desc').limit(10).get();
      var rawOrders = Array.isArray(orderRes.data) ? orderRes.data : [];
      // 增强订单数据：提取商品名、状态文本
      orders = rawOrders.map(function(o) {
        // 商品名：优先从 items 数组提取，回退到顶层 product_name
        var itemNames = (o.items || []).map(function(i) { return i.product_name || i.name || ''; }).filter(function(n) { return n; });
        var productNames = itemNames.length > 0 ? itemNames.join('、') : (o.product_name || '');
        // 状态：确保数字类型匹配
        var st = o.status != null ? Number(o.status) : -1;
        return {
          _id: o._id,
          order_no: o.order_no || '',
          product_names: productNames || '未命名商品',
          total_rent: o.total_rent || 0,
          status: st,
          status_label: orderStatusMap[st] || ('状态' + st),
          rental_days: (o.items && o.items[0]) ? (o.items[0].rental_days || 0) : 0,
          created_at: o.created_at,
          updated_at: o.updated_at
        };
      });
    } catch (e) { /* 忽略 */ }

    // 认证资料（兼容旧数据：优先 user_id，回退 _openid）
    var verification = null;
    try {
      var verRes = await db.collection('verifications').where(
        _.or([{ user_id: userId }, { _openid: u._openid || '' }])
      ).orderBy('created_at', 'desc').limit(1).get();
      var verList = Array.isArray(verRes.data) ? verRes.data : [];
      if (verList.length > 0) {
        var v = verList[0];
        // 收集所有 cloud:// 图片 fileID
        var imgFields = ['student_card_img','student_id_card_img','id_card_front_img','id_card_back_img','xuexin_img','sesame_img'];
        var imgFileIDs = [];
        imgFields.forEach(function(f) { if (v[f] && v[f].startsWith('cloud://')) imgFileIDs.push(v[f]); });
        // 转为临时 HTTPS 链接
        var imgURLs = {};
        if (imgFileIDs.length > 0) {
          try {
            var tempRes = await tcb.getTempFileURL({ fileList: imgFileIDs });
            (tempRes.fileList || []).forEach(function(item, idx) {
              if (item.tempFileURL) imgURLs[imgFileIDs[idx]] = item.tempFileURL;
            });
          } catch (e) { /* 转换失败则保留原值 */ }
        }
        verification = {
          status: v.status,
          auth_type: v.auth_type,
          real_name: v.real_name || '',
          id_card: (v.id_card || '').replace(/(\d{6})\d{8}(\d{4})/, '$1********$2'),
          school_name: v.school_name || '',
          student_id: v.student_id || '',
          enrollment_year: v.enrollment_year || '',
          graduation_year: v.graduation_year || '',
          student_card_img: imgURLs[v.student_card_img] || v.student_card_img || '',
          student_id_card_img: imgURLs[v.student_id_card_img] || v.student_id_card_img || '',
          id_card_front_img: imgURLs[v.id_card_front_img] || v.id_card_front_img || '',
          id_card_back_img: imgURLs[v.id_card_back_img] || v.id_card_back_img || '',
          xuexin_img: imgURLs[v.xuexin_img] || v.xuexin_img || '',
          sesame_img: imgURLs[v.sesame_img] || v.sesame_img || '',
          created_at: v.created_at
        };
      }
    } catch (e) { /* 忽略 */ }

    // 操作日志
    var logs = [];
    try {
      var logRes = await db.collection('user_operation_logs').where({ user_id: userId })
        .orderBy('created_at', 'desc').limit(20).get();
      logs = Array.isArray(logRes.data) ? logRes.data : [];
    } catch (e) { /* 集合可能不存在 */ }

    // 合并日志（该用户作为主账号或副账号的合并记录）
    var mergeLogs = [];
    try {
      var mergeLogRes = await db.collection('user_merge_logs')
        .where(_.or([
          { primary_user_id: userId },
          { secondary_user_ids: _.in([userId]) }
        ]))
        .orderBy('created_at', 'desc').limit(10).get();
      mergeLogs = Array.isArray(mergeLogRes.data) ? mergeLogRes.data : [];
    } catch (e) { /* 集合可能不存在 */ }

    // 积分流水（最近30条）
    var pointLogs = [];
    try {
      var pointLogRes = await db.collection('point_logs')
        .where({ _openid: u._openid })
        .orderBy('created_at', 'desc').limit(30).get();
      pointLogs = Array.isArray(pointLogRes.data) ? pointLogRes.data : [];
    } catch (e) { /* 集合可能不存在 */ }

    // 经验流水（最近30条）
    var expLogs = [];
    try {
      var expLogRes = await db.collection('exp_logs')
        .where({ _openid: u._openid })
        .orderBy('created_at', 'desc').limit(30).get();
      expLogs = Array.isArray(expLogRes.data) ? expLogRes.data : [];
    } catch (e) { /* 集合可能不存在 */ }

    // 如果该用户被合并到其他用户，查询主账号信息
    var mergedIntoUser = null;
    if (u.merged_into) {
      try {
        var primaryDoc = await db.collection('users').doc(u.merged_into).get();
        var primaryUsers = Array.isArray(primaryDoc.data) ? primaryDoc.data : (primaryDoc.data ? [primaryDoc.data] : []);
        if (primaryUsers.length > 0) {
          var pu = primaryUsers[0];
          var pPhone = pu.phone || '';
          if (pPhone.length >= 11) { pPhone = pPhone.substring(0, 3) + '****' + pPhone.substring(pPhone.length - 4); }
          mergedIntoUser = { _id: pu._id, nickname: pu.nickname || '', phone: pPhone };
        }
      } catch (e) { /* 忽略 */ }
    }

    res.json({
      user: {
        _id: u._id, uid: u.uid || '', _openid: u._openid || '', nickname: u.nickname || '',
        phone: u.phone || u.phone_full || '', auth_status: u.auth_status || 0,
        auth_type: u.auth_type || 0, auth_source: u.auth_source || 'manual',
        school_name: u.school_name || '',
        student_validity_start: u.student_validity_start || '',
        student_validity_end: u.student_validity_end || '',
        wechat_verify_id: u.wechat_verify_id || '',
        exp: u.exp || 0, points: u.points || 0,
        member_level: u.member_level || u.level || '会员',
        face_verified: u.face_verified || 0,
        merged_into: u.merged_into || null,
        merged_into_user: mergedIntoUser,
        deleted_at: u.deleted_at || null,
        created_at: u.created_at
      },
      bindings: bindings.map(function(b) {
        return { appid: b.appid || '', openid: b.openid || '', is_primary: b.is_primary || 0, created_at: b.created_at };
      }),
      verification: verification,
      recentOrders: orders,
      operationLogs: logs.map(function(l) {
        return { action: l.action || '', detail: l.detail || '', created_at: l.created_at };
      }),
      mergeLogs: mergeLogs,
      pointLogs: pointLogs.map(function(l) {
        return { type: l.type || '', amount: l.amount || 0, source: l.source || '', order_id: l.order_id || '', created_at: l.created_at };
      }),
      expLogs: expLogs.map(function(l) {
        return { type: l.type || '', amount: l.amount || 0, source: l.source || '', order_id: l.order_id || '', rating: l.rating, created_at: l.created_at };
      })
    });
  } catch (e) { hideError(res, e); }
});

// 删除用户及其全部关联数据
app.delete('/api/users/:id', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var userId = req.params.id;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    // 先获取用户信息以拿到 _openid
    var userDoc;
    try {
      userDoc = await db.collection('users').doc(userId).get();
    } catch (e) {
      return res.status(404).json({ error: '用户不存在' });
    }
    var users = Array.isArray(userDoc.data) ? userDoc.data : (userDoc.data ? [userDoc.data] : []);
    if (users.length === 0) return res.status(404).json({ error: '用户不存在' });
    var u = users[0];
    var userOpenid = u._openid || '';

    var deleted = {};

    // 1. 删除微信绑定
    try {
      var bindRes = await db.collection('wechat_bindings').where({ user_id: userId }).remove();
      deleted.wechat_bindings = (bindRes && bindRes.deleted) || 0;
    } catch (e) { deleted.wechat_bindings = 'error: ' + e.message; }

    // 2. 删除认证记录
    try {
      var verRes = await db.collection('verifications').where(
        _.or([{ user_id: userId }, { _openid: userOpenid }])
      ).remove();
      deleted.verifications = (verRes && verRes.deleted) || 0;
    } catch (e) { deleted.verifications = 'error: ' + e.message; }

    // 3. 删除订单
    if (userOpenid) {
      try {
        var orderRes = await db.collection('orders').where({ _openid: userOpenid }).remove();
        deleted.orders = (orderRes && orderRes.deleted) || 0;
      } catch (e) { deleted.orders = 'error: ' + e.message; }
    }

    // 4. 删除评价
    if (userOpenid) {
      try {
        var reviewRes = await db.collection('reviews').where({ _openid: userOpenid }).remove();
        deleted.reviews = (reviewRes && reviewRes.deleted) || 0;
      } catch (e) { deleted.reviews = 'error: ' + e.message; }
    }

    // 5. 删除签到记录
    if (userOpenid) {
      try {
        var checkinRes = await db.collection('checkins').where({ _openid: userOpenid }).remove();
        deleted.checkins = (checkinRes && checkinRes.deleted) || 0;
      } catch (e) { deleted.checkins = 'error: ' + e.message; }
    }

    // 6. 删除操作日志
    try {
      var logRes = await db.collection('user_operation_logs').where({ user_id: userId }).remove();
      deleted.operation_logs = (logRes && logRes.deleted) || 0;
    } catch (e) { deleted.operation_logs = 'error: ' + e.message; }

    // 7. 删除合并日志
    try {
      var mergeRes = await db.collection('user_merge_logs').where(
        _.or([{ primary_user_id: userId }, { secondary_user_ids: _.in([userId]) }])
      ).remove();
      deleted.merge_logs = (mergeRes && mergeRes.deleted) || 0;
    } catch (e) { deleted.merge_logs = 'error: ' + e.message; }

    // 8. 最后删除用户本身
    try {
      await db.collection('users').doc(userId).remove();
      deleted.user = true;
    } catch (e) {
      return res.status(500).json({ error: '删除用户失败: ' + e.message, deleted: deleted });
    }

    console.log('[Admin] 用户已删除:', userId, 'openid:', userOpenid, JSON.stringify(deleted));
    res.json({ msg: '用户及全部关联数据已删除', deleted: deleted });
  } catch (e) { hideError(res, e); }
});

// ==================== 优惠券模板管理 ====================

// 获取模板列表（branch 只看 enabled）
app.get('/api/coupon-templates', authRequired, async (req, res) => {
  try {
    var result = await tcb.callFunction({
      name: 'manageCouponTemplates',
      data: { action: 'list', operatorRole: req.adminRole }
    });
    var data = (result && result.result) || {};
    res.json({ list: (data.data && data.data.list) || [] });
  } catch (e) { hideError(res, e); }
});

// 保存模板（新增/编辑，仅 super）
app.post('/api/coupon-templates/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { templateId, templateName, couponType, discount, maxDiscountAmount,
          minOrderAmount, applicableScope, validDays, stackable, enabled } = req.body;
    if (!templateName || !couponType) return res.status(400).json({ error: '模板名称和类型必填' });

    var action = templateId ? 'update' : 'create';
    var result = await tcb.callFunction({
      name: 'manageCouponTemplates',
      data: {
        action, templateId, templateName, couponType,
        discount: Number(discount) || 0.95,
        maxDiscountAmount: Number(maxDiscountAmount) || 0,
        minOrderAmount: Number(minOrderAmount) || 0,
        applicableScope: applicableScope || 'all',
        validDays: Number(validDays) || 30,
        stackable: !!stackable,
        enabled: enabled !== false,
        operatorRole: 'super'
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, templateId: data.templateId });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 切换模板启用状态（仅 super）
app.post('/api/coupon-templates/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { templateId } = req.body;
    if (!templateId) return res.status(400).json({ error: '缺少模板ID' });
    var result = await tcb.callFunction({
      name: 'manageCouponTemplates',
      data: { action: 'toggle', templateId, operatorRole: 'super' }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, enabled: data.enabled });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// ==================== 优惠券申请管理 ====================

// 搜索用户（供分点使用）
app.get('/api/coupon-applications/search-user', authRequired, async (req, res) => {
  try {
    var { keyword } = req.query;
    if (!keyword || keyword.length < 2) return res.status(400).json({ error: '请输入至少2个字符搜索' });
    var result = await tcb.callFunction({
      name: 'searchUserForCoupon',
      data: { keyword }
    });
    var data = (result && result.result) || {};
    res.json({ list: (data.data && data.data.list) || [] });
  } catch (e) { hideError(res, e); }
});

// 申请列表
app.get('/api/coupon-applications', authRequired, async (req, res) => {
  try {
    var { status, page, pageSize } = req.query;
    var callData = { page: Number(page) || 1, pageSize: Number(pageSize) || 20 };
    if (status && status !== 'all') callData.status = status;
    // 分点只看自己的
    if (req.adminRole === 'branch' && req.adminSchool) {
      callData.branch_school = req.adminSchool;
    }
    var result = await tcb.callFunction({
      name: 'listCouponApplications',
      data: callData
    });
    var data = (result && result.result) || {};
    var listData = data.data || {};
    res.json({
      list: listData.list || [],
      total: listData.total || 0,
      page: listData.page || Number(page) || 1,
      pageSize: listData.pageSize || Number(pageSize) || 20
    });
  } catch (e) { hideError(res, e); }
});

// 提交申请（分点专用）
app.post('/api/coupon-applications/submit', authRequired, async (req, res) => {
  try {
    // 全链路权限校验（本接口是唯一 403 出口，无全局守卫/无多层中间件叠加）：
    // - 总号（super）统一管理优惠券，可直接创建/管理模板并审核申请，不走「提交申请」流程；
    // - 分校（分点）管理员提交本校申请。
    // 分校身份判定为「非 super 且具备分校上下文（school 或 branchId）」，并兼容显式 role === 'branch'，
    // 以抵御登录态字段丢失 / 角色枚举历史差异（authRequired 中 `session.role || 'super'` 的兜底）
    // 造成的合法分校身份误判。
    var isSuper = req.adminRole === 'super';
    var branchSchool = req.adminSchool || '';
    var branchId = req.adminBranchId || '';
    var isBranchAdmin = !isSuper && (req.adminRole === 'branch' || !!branchSchool || !!branchId);
    // 1) 显式总号：权限完全保留，仅提示走直接创建流程（准确文案，非反向报错）
    if (isSuper) {
      return res.status(403).json({ error: '总号可直接创建优惠券模板，无需提交申请' });
    }
    // 2) 真正无权限的角色（既非总号也无任何分校上下文）：正常 403
    if (!isBranchAdmin) {
      return res.status(403).json({ error: '无权限：仅分校管理员可提交优惠券申请' });
    }
    // 3) 分校身份成立但登录态缺少分校标识：属于登录态/参数异常，返回 400 而非 403，
    //    并提示重新登录（重新登录会刷新内存会话缓存，使修复即时生效）。
    if (!branchSchool) {
      return res.status(400).json({ error: '登录态缺少分校标识，请退出后重新登录再提交' });
    }
    var { user_id, template_id, reason } = req.body;
    if (!user_id || !template_id) return res.status(400).json({ error: '请选择用户和优惠券模板' });
    var result = await tcb.callFunction({
      name: 'submitCouponApplication',
      data: {
        user_id, template_id, reason: reason || '',
        // 权限边界：分校标识一律取自服务端登录态（req.adminSchool），
        // 不接受前端传参，确保分校管理员只能提交本分校申请，杜绝越权。
        branch_school: branchSchool,
        branch_admin: branchSchool,
        adminKey: ADMIN_API_KEY
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, application_id: (data.data && data.data.application_id) });
    } else {
      res.status(400).json({ error: data.msg || '提交失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 通过申请（总号专用）
app.post('/api/coupon-applications/approve', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: '缺少申请ID' });
    var result = await tcb.callFunction({
      name: 'approveCouponApplication',
      data: { application_id, adminKey: ADMIN_API_KEY }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, coupon_id: data.coupon_id });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 驳回申请（总号专用）
app.post('/api/coupon-applications/reject', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { application_id, reject_reason } = req.body;
    if (!application_id) return res.status(400).json({ error: '缺少申请ID' });
    if (!reject_reason || !reject_reason.trim()) return res.status(400).json({ error: '请填写驳回原因' });
    var result = await tcb.callFunction({
      name: 'rejectCouponApplication',
      data: { application_id, reject_reason: reject_reason.trim(), adminKey: ADMIN_API_KEY }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: '已驳回' });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// ==================== 热租榜单管理 ====================

// 获取热租榜单配置列表
app.get('/api/home-hot-products', authRequired, async (req, res) => {
  try {
    var { branchId, page, pageSize } = req.query;
    var callData = {
      action: 'list',
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50
    };
    // 分点只看自己的
    if (req.adminRole === 'branch' && req.adminSchool) {
      callData.branchId = req.adminSchool;
    } else if (branchId) {
      callData.branchId = branchId;
    }
    var result = await tcb.callFunction({
      name: 'homeHotProducts',
      data: callData
    });
    var data = (result && result.result) || {};
    var listData = (data.code === 0 && data.data) || {};
    res.json({
      list: listData.list || [],
      total: listData.total || 0,
      page: listData.page || Number(page) || 1,
      pageSize: listData.pageSize || Number(pageSize) || 50
    });
  } catch (e) { hideError(res, e); }
});

// 添加热租商品（仅 super）
app.post('/api/home-hot-products/add', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { productId, branchId, sort } = req.body;
    if (!productId) return res.status(400).json({ error: '请选择商品' });
    var result = await tcb.callFunction({
      name: 'homeHotProducts',
      data: {
        action: 'add',
        productId: productId,
        branchId: branchId || 'global',
        sort: Number(sort) || 999,
        branchName: req.body.branchName || '',
        operatorId: req.adminSchool || 'super_admin',
        operatorName: req.adminSchool || '管理员',
        operatorRole: req.adminRole
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, _id: (data.data && data.data._id) });
    } else {
      res.status(400).json({ error: data.msg || '添加失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 更新排序（仅 super）
app.post('/api/home-hot-products/update-sort', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { hotProductId, sort } = req.body;
    if (!hotProductId) return res.status(400).json({ error: '缺少配置ID' });
    if (sort === undefined || sort === null) return res.status(400).json({ error: '缺少排序值' });
    var result = await tcb.callFunction({
      name: 'homeHotProducts',
      data: {
        action: 'updateSort',
        hotProductId: hotProductId,
        sort: Number(sort),
        operatorId: req.adminSchool || 'super_admin',
        operatorName: req.adminSchool || '管理员',
        operatorRole: req.adminRole
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 移除热租商品（仅 super）
app.post('/api/home-hot-products/remove', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { hotProductId } = req.body;
    if (!hotProductId) return res.status(400).json({ error: '缺少配置ID' });
    var result = await tcb.callFunction({
      name: 'homeHotProducts',
      data: {
        action: 'remove',
        hotProductId: hotProductId,
        operatorId: req.adminSchool || 'super_admin',
        operatorName: req.adminSchool || '管理员',
        operatorRole: req.adminRole
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 启用/禁用热租商品（仅 super）
app.post('/api/home-hot-products/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { hotProductId } = req.body;
    if (!hotProductId) return res.status(400).json({ error: '缺少配置ID' });
    var result = await tcb.callFunction({
      name: 'homeHotProducts',
      data: {
        action: 'toggle',
        hotProductId: hotProductId,
        operatorId: req.adminSchool || 'super_admin',
        operatorName: req.adminSchool || '管理员',
        operatorRole: req.adminRole
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, enabled: (data.data && data.data.enabled) });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 清理失效热租商品（无 productId 或商品已删除的条目）
app.post('/api/home-hot-products/cleanup', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var result = await tcb.callFunction({
      name: 'homeHotProducts',
      data: {
        action: 'cleanup',
        operatorId: req.adminSchool || 'super_admin',
        operatorName: req.adminSchool || '管理员'
      }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg || '清理完成', removed: data.data ? data.data.removed : 0 });
    } else {
      res.status(400).json({ error: data.msg || '清理失败' });
    }
  } catch (e) { hideError(res, e); }
});

// ==================== 第二阶段：设备预约占用 ====================

// 设备可用性检查
app.get('/api/devices/check-availability', authRequired, async (req, res) => {
  try {
    var { productId, branchId, schoolId, startDate, endDate } = req.query;
    if (!productId) return res.status(400).json({ error: '请选择商品' });
    var result = await tcb.callFunction({
      name: 'checkProductAvailability',
      data: {
        action: 'check',
        productId: productId,
        branchId: branchId || req.adminBranchId || '',
        schoolId: schoolId || '',
        startDate: startDate || new Date().toISOString().slice(0, 10),
        endDate: endDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
      }
    });
    var data = (result && result.result) || {};
    res.json(data.code === 0 ? (data.data || {}) : { error: data.msg });
  } catch (e) { hideError(res, e); }
});

// 设备预约列表
app.get('/api/device-reservations', authRequired, async (req, res) => {
  try {
    var { productId, deviceId, branchId, schoolId, status, page, pageSize } = req.query;
    var callData = {
      action: 'list',
      productId: productId || '',
      deviceId: deviceId || '',
      status: status || '',
      page: Number(page) || 1,
      pageSize: Math.min(Number(pageSize) || 20, 100)
    };
    // 分点只看自己的
    if (req.adminRole === 'branch') {
      callData.schoolId = req.adminBranchId || '';
    } else if (schoolId) {
      callData.schoolId = schoolId;
    }
    if (branchId) callData.branchId = branchId;
    var result = await tcb.callFunction({
      name: 'reserveDeviceForOrder',
      data: callData
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    var listData = (data.code === 0 && data.data) || {};
    res.json({ list: listData.list || [], total: listData.total || 0, page: listData.page || 1, pageSize: listData.pageSize || 20 });
  } catch (e) { hideError(res, e); }
});

// 手动预约设备（管理员操作）
app.post('/api/device-reservations/reserve', authRequired, async (req, res) => {
  try {
    var { deviceId, productId, orderId, startDate, endDate, branchId, schoolId, schoolName } = req.body;
    if (!productId || !startDate || !endDate) return res.status(400).json({ error: '缺少必要参数' });
    var result = await tcb.callFunction({
      name: 'reserveDeviceForOrder',
      data: {
        action: 'reserve',
        deviceId: deviceId || '',
        productId: productId,
        orderId: orderId || '',
        startDate: startDate,
        endDate: endDate,
        branchId: branchId || '',
        schoolId: schoolId || '',
        schoolName: schoolName || ''
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg, reservationId: (data.data && data.data.reservationId), deviceId: (data.data && data.data.deviceId) });
    } else {
      res.status(400).json({ error: data.msg || '预约失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 释放预约
app.post('/api/device-reservations/release', authRequired, async (req, res) => {
  try {
    var { reservationId, orderId } = req.body;
    if (!reservationId && !orderId) return res.status(400).json({ error: '缺少预约ID或订单ID' });
    var result = await tcb.callFunction({
      name: 'reserveDeviceForOrder',
      data: { action: 'release', reservationId: reservationId || '', orderId: orderId || '' }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '释放失败' });
    }
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 飞书外部订单同步（触发 syncFeishuOrders 云函数）
// ═══════════════════════════════════════════════════════════════
app.post('/api/feishu/sync-orders', authRequired, async (req, res) => {
  try {
    // 仅超级管理员可触发
    if (req.adminRole !== 'super') {
      return res.status(403).json({ ok: false, error: '仅超级管理员可执行此操作' });
    }
    const tcbApp = require('@cloudbase/node-sdk').init({
      env: CLOUD_ENV,
      secretId: CLOUD_SECRET_ID,
      secretKey: CLOUD_SECRET_KEY
    });
    console.log('[feishu/sync-orders] 开始调用 syncFeishuOrders 云函数...');
    const tcbResult = await tcbApp.callFunction({
      name: 'syncFeishuOrders',
      data: { action: 'sync' }
    });
    // 云函数返回值可能在 result.result 或直接是 result
    var data = tcbResult.result || tcbResult;
    console.log('[feishu/sync-orders] 云函数返回:', JSON.stringify(data));
    // 统一返回标准 JSON 格式
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[feishu/sync-orders] 调用失败:', e.message, e.stack || '');
    // 区分错误类型
    var errMsg = e.message || '';
    if (errMsg.includes('FunctionName') || errMsg.includes('not found') || errMsg.includes('FUNCTION_NOT_FOUND')) {
      return res.status(500).json({ ok: false, error: 'syncFeishuOrders 云函数未部署，请先在微信开发者工具中上传并部署该云函数' });
    }
    if (errMsg.includes('auth') || errMsg.includes('credentials') || errMsg.includes('secret')) {
      return res.status(500).json({ ok: false, error: '云函数调用鉴权失败，请检查 CLOUD_SECRET_ID/CLOUD_SECRET_KEY 配置' });
    }
    res.status(500).json({ ok: false, error: '飞书同步失败：' + errMsg + '。请确认 syncFeishuOrders 云函数已部署，且已配置 FEISHU_APP_ID/FEISHU_APP_SECRET 环境变量。' });
  }
});

// 飞书同步状态查询
app.get('/api/feishu/sync-status', authRequired, async (req, res) => {
  try {
    const tcbApp = require('@cloudbase/node-sdk').init({
      env: CLOUD_ENV,
      secretId: CLOUD_SECRET_ID,
      secretKey: CLOUD_SECRET_KEY
    });
    const tcbResult = await tcbApp.callFunction({
      name: 'syncFeishuOrders',
      data: { action: 'status' }
    });
    var data = tcbResult.result || tcbResult;
    console.log('[feishu/sync-status] 云函数返回:', JSON.stringify(data));
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[feishu/sync-status] 调用失败:', e.message, e.stack || '');
    res.status(500).json({ ok: false, error: '查询失败：' + e.message });
  }
});

// 飞书权限诊断（逐层测试 Base / Table 访问）
app.get('/api/feishu/diagnose', authRequired, async (req, res) => {
  try {
    console.log('[feishu/diagnose] 开始诊断飞书权限...');
    const tcbApp = require('@cloudbase/node-sdk').init({
      env: CLOUD_ENV,
      secretId: CLOUD_SECRET_ID,
      secretKey: CLOUD_SECRET_KEY
    });
    const tcbResult = await tcbApp.callFunction({
      name: 'syncFeishuOrders',
      data: { action: 'diagnose' }
    });
    var data = tcbResult.result || tcbResult;
    console.log('[feishu/diagnose] 云函数返回:', JSON.stringify(data));
    res.json(data);
  } catch (e) {
    console.error('[feishu/diagnose] 调用失败:', e.message, e.stack || '');
    res.status(500).json({ ok: false, error: '诊断调用失败：' + e.message });
  }
});

// ==================== 第二阶段：库存预警规则 ====================

// 预警规则列表
app.get('/api/stock-warning-rules', authRequired, async (req, res) => {
  try {
    var where = {};
    if (req.adminRole === 'branch' && req.adminBranchId) {
      where.branchId = req.adminBranchId;
    }
    var { data: list } = await db.collection('stock_warning_rules').where(where).orderBy('createdAt', 'desc').get();
    list = Array.isArray(list) ? list : [];
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// 保存预警规则
app.post('/api/stock-warning-rules/save', authRequired, async (req, res) => {
  try {
    var { ruleId, branchId, branchName, productId, productName, safeStock, enabled } = req.body;
    if (!branchId || !productId) return res.status(400).json({ error: '请选择分点和商品' });
    if (safeStock == null || safeStock < 0) return res.status(400).json({ error: '请输入安全库存数' });

    // 获取商品名（如果没传）
    if (!productName) {
      try {
        var prodDoc = await db.collection('products').doc(productId).get();
        var prod = Array.isArray(prodDoc.data) ? prodDoc.data[0] : prodDoc.data;
        if (prod) productName = prod.name || '';
      } catch (e) { /* 忽略 */ }
    }
    if (!branchName) {
      var binfo = getBranchInfo(branchId);
      branchName = binfo ? binfo.schoolName : branchId;
    }

    var data = {
      branchId: branchId,
      branchName: branchName,
      productId: productId,
      productName: productName || '',
      safeStock: Number(safeStock),
      enabled: enabled !== false,
      updatedAt: new Date()
    };

    if (ruleId) {
      await db.collection('stock_warning_rules').doc(ruleId).update(data);
    } else {
      data.createdAt = new Date();
      await db.collection('stock_warning_rules').add(data);
    }
    res.json({ msg: ruleId ? '已更新' : '已创建' });
  } catch (e) { hideError(res, e); }
});

// 删除预警规则
app.post('/api/stock-warning-rules/delete', authRequired, async (req, res) => {
  try {
    var { ruleId } = req.body;
    if (!ruleId) return res.status(400).json({ error: '缺少规则ID' });
    await db.collection('stock_warning_rules').doc(ruleId).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// 库存预警汇总（仪表盘用）
app.get('/api/stock-warning-summary', authRequired, async (req, res) => {
  try {
    var where = { enabled: true };
    if (req.adminRole === 'branch' && req.adminBranchId) {
      where.branchId = req.adminBranchId;
    }
    var { data: rules } = await db.collection('stock_warning_rules').where(where).get();
    rules = Array.isArray(rules) ? rules : [];

    var warnings = [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      try {
        var availableWhere = {
          product_id: rule.productId,
          status: _.in(['available', '在库']),
          currentBranchId: rule.branchId
        };
        var { total } = await db.collection('devices').where(availableWhere).count();
        if (total < rule.safeStock) {
          warnings.push({
            branchId: rule.branchId,
            branchName: rule.branchName,
            productId: rule.productId,
            productName: rule.productName,
            currentStock: total,
            safeStock: rule.safeStock,
            shortage: rule.safeStock - total,
            level: total === 0 ? 'critical' : 'warning'
          });
        }
      } catch (e) { /* 跳过查询失败的 */ }
    }

    res.json({ warnings: warnings, total: warnings.length });
  } catch (e) { hideError(res, e); }
});

// ==================== 第二阶段：设备调配管理 ====================

// 调配单列表
app.get('/api/device-transfers', authRequired, async (req, res) => {
  try {
    var { status, fromBranchId, toBranchId, page, pageSize } = req.query;
    var callData = {
      action: 'list',
      status: status || '',
      page: Number(page) || 1,
      pageSize: Math.min(Number(pageSize) || 20, 100)
    };
    if (fromBranchId) callData.fromBranchId = fromBranchId;
    if (toBranchId) callData.toBranchId = toBranchId;
    // 分点只看自己相关的调配单
    if (req.adminRole === 'branch' && req.adminBranchId) {
      callData.operatorBranchId = req.adminBranchId;
    }
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: callData
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    var listData = (data.code === 0 && data.data) || {};
    res.json({ list: listData.list || [], total: listData.total || 0, page: listData.page || 1, pageSize: listData.pageSize || 20 });
  } catch (e) { hideError(res, e); }
});

// 创建调配单
app.post('/api/device-transfers/create', authRequired, async (req, res) => {
  try {
    var { deviceId, productId, productName, deviceCode, toBranchId, toBranchName,
          relatedOrderId, reason, priority } = req.body;
    if (!deviceId && !productId) return res.status(400).json({ error: '请选择商品或设备' });
    if (!toBranchId) return res.status(400).json({ error: '请选择目标分点' });

    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: {
        action: 'create',
        deviceId: deviceId || '',
        productId: productId || '',
        productName: productName || '',
        deviceCode: deviceCode || '',
        fromBranchId: req.adminBranchId || '',
        fromBranchName: req.adminSchool || '',
        toBranchId: toBranchId,
        toBranchName: toBranchName || '',
        relatedOrderId: relatedOrderId || '',
        reason: reason || '',
        priority: priority || 'normal',
        applicantAdminId: req.adminSchool || '',
        applicantName: req.adminSchool || '',
        remark: ''
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      var transferData = data.data || {};
      res.json({
        msg: data.msg,
        transferId: transferData.transferId,
        transferNo: transferData.transferNo,
        approvalLevel: transferData.approvalLevel,
        status: transferData.status
      });
    } else {
      res.status(400).json({ error: data.msg || '创建失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 审批调配单
app.post('/api/device-transfers/approve', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可审批' });
    var { transferId } = req.body;
    if (!transferId) return res.status(400).json({ error: '缺少调配单ID' });
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: {
        action: 'approve',
        transferId: transferId,
        approverAdminId: 'super_admin',
        approverName: '主管理员'
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '审批失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 驳回调配单
app.post('/api/device-transfers/reject', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { transferId, rejectReason } = req.body;
    if (!transferId) return res.status(400).json({ error: '缺少调配单ID' });
    if (!rejectReason) return res.status(400).json({ error: '请填写驳回原因' });
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: {
        action: 'reject',
        transferId: transferId,
        rejectReason: rejectReason,
        approverAdminId: 'super_admin',
        approverName: '主管理员'
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '驳回失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 确认调出（来源分点）
app.post('/api/device-transfers/confirm-out', authRequired, async (req, res) => {
  try {
    var { transferId } = req.body;
    if (!transferId) return res.status(400).json({ error: '缺少调配单ID' });
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: {
        action: 'confirmOut',
        transferId: transferId,
        operatorBranchId: req.adminBranchId || ''
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 确认到达（目标分点）
app.post('/api/device-transfers/confirm-in', authRequired, async (req, res) => {
  try {
    var { transferId } = req.body;
    if (!transferId) return res.status(400).json({ error: '缺少调配单ID' });
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: {
        action: 'confirmIn',
        transferId: transferId,
        operatorBranchId: req.adminBranchId || ''
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '操作失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 取消调配单
app.post('/api/device-transfers/cancel', authRequired, async (req, res) => {
  try {
    var { transferId } = req.body;
    if (!transferId) return res.status(400).json({ error: '缺少调配单ID' });
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: {
        action: 'cancel',
        transferId: transferId
      }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json({ msg: data.msg });
    } else {
      res.status(400).json({ error: data.msg || '取消失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 调配单详情
app.get('/api/device-transfers/detail', authRequired, async (req, res) => {
  try {
    var { transferId } = req.query;
    if (!transferId) return res.status(400).json({ error: '缺少调配单ID' });
    var result = await tcb.callFunction({
      name: 'manageDeviceTransfers',
      data: { action: 'detail', transferId: transferId }
    }, { timeout: 30000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json(data.data || {});
    } else {
      res.status(400).json({ error: data.msg || '查询失败' });
    }
  } catch (e) { hideError(res, e); }
});

// ==================== 第二阶段：异常标签 ====================

// 重新计算订单异常标签
app.post('/api/orders/recalculate-tags', authRequired, async (req, res) => {
  try {
    var { orderId, action } = req.body;
    var callAction = orderId ? 'calculate' : 'batchUpdate';
    var result = await tcb.callFunction({
      name: 'calculateAbnormalTags',
      data: { action: callAction, orderId: orderId || '' }
    });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json(data.data || { msg: '计算完成' });
    } else {
      res.status(400).json({ error: data.msg || '计算失败' });
    }
  } catch (e) { hideError(res, e); }
});

// 异常统计
app.get('/api/orders/abnormal-stats', authRequired, async (req, res) => {
  try {
    var callData = { action: 'dashboard' };
    if (req.adminRole === 'branch' && req.adminBranchId) {
      callData.branchId = req.adminBranchId;
    }
    var result = await tcb.callFunction({
      name: 'calculateAbnormalTags',
      data: callData
    });
    var data = (result && result.result) || {};
    res.json(data.code === 0 ? (data.data || {}) : {});
  } catch (e) { hideError(res, e); }
});

// ==================== 第二阶段：增强仪表盘 ====================

app.get('/api/dashboard/enhanced', authRequired, async (req, res) => {
  try {
    var branchId = req.adminRole === 'branch' ? req.adminBranchId : '';
    var branchFilter = branchId ? { schoolId: branchId } : {};

    // 今日统计
    var today = new Date().toISOString().slice(0, 10);
    var todayStart = new Date(today + 'T00:00:00.000Z');
    var orderWhere = branchId ? _.and([{ created_at: _.gte(todayStart) }, _.or([{ schoolId: branchId }, { branchId: branchId }])]) : { created_at: _.gte(todayStart) };

    var { total: todayOrders } = await db.collection('orders').where(orderWhere).count();

    // 待发货 (status=3)
    var shipWhere = branchId ? _.and([{ status: 3 }, _.or([{ schoolId: branchId }, { branchId: branchId }])]) : { status: 3 };
    var { total: pendingShip } = await db.collection('orders').where(shipWhere).count();

    // 待归还 (status=4 or status=6)
    var returnWhere = branchId ? _.and([{ status: _.in([4, 6]) }, _.or([{ schoolId: branchId }, { branchId: branchId }])]) : { status: _.in([4, 6]) };
    var { total: pendingReturn } = await db.collection('orders').where(returnWhere).count();

    // 库存预警数
    var warnWhere = { enabled: true };
    if (branchId) warnWhere.branchId = branchId;
    var { data: warnRules } = await db.collection('stock_warning_rules').where(warnWhere).get();
    warnRules = Array.isArray(warnRules) ? warnRules : [];
    var stockWarnings = 0;
    for (var i = 0; i < warnRules.length; i++) {
      var r = warnRules[i];
      var { total: avail } = await db.collection('devices').where({
        product_id: r.productId, status: _.in(['available', '在库']), currentBranchId: r.branchId
      }).count();
      if (avail < r.safeStock) stockWarnings++;
    }

    // 待审批调配单
    var tfWhere = branchId ? _.and([{ status: 'pending' }, _.or([{ fromBranchId: branchId }, { toBranchId: branchId }])]) : { status: 'pending' };
    var { total: pendingTransfers } = await db.collection('device_transfers').where(tfWhere).count();

    // 异常订单数
    var abnWhere = branchId ? _.and([
      { status: _.in([1, 2, 3, 4, 6]) },
      { abnormalTags: _.and(_.exists(true), _.neq([]), _.neq(null)) },
      _.or([{ schoolId: branchId }, { branchId: branchId }])
    ]) : { status: _.in([1, 2, 3, 4, 6]), abnormalTags: _.and(_.exists(true), _.neq([]), _.neq(null)) };
    var { total: abnormalOrders } = await db.collection('orders').where(abnWhere).count();

    res.json({
      todayOrders: todayOrders,
      pendingShip: pendingShip,
      pendingReturn: pendingReturn,
      stockWarnings: stockWarnings,
      pendingTransfers: pendingTransfers,
      abnormalOrders: abnormalOrders,
      role: req.adminRole,
      branchId: branchId
    });
  } catch (e) { hideError(res, e); }
});

// ==================== 第三阶段：工作台 + 排名 ====================

// 分点工作台 / 总号工作台
app.get('/api/dashboard/workspace', authRequired, async (req, res) => {
  try {
    var action = req.adminRole === 'branch' ? 'branch' : 'main';
    var callData = { action: action };
    if (req.adminRole === 'branch') {
      callData.branchId = req.adminBranchId || '';
      callData.branchName = req.adminSchool || '';
    }
    var result = await tcb.callFunction({
      name: 'getBranchDashboard',
      data: callData
    }, { timeout: 60000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json(data.data || {});
    } else {
      res.status(500).json({ error: data.msg || data.error || '云函数返回异常', code: data.code });
    }
  } catch (e) {
    console.error('[Dashboard] 云函数调用失败:', e.message, e.stack || '');
    res.status(500).json({ error: '云函数调用失败: ' + (e.message || '未知'), stack: String(e.stack || '').split('\n').slice(0, 3).join('\n') });
  }
});

// 分点排名
app.get('/api/branch-ranking', authRequired, async (req, res) => {
  try {
    var { action, period } = req.query;
    var result = await tcb.callFunction({
      name: 'getBranchRanking',
      data: {
        action: action || 'summary',
        period: period || 'week'
      }
    }, { timeout: 60000 });
    var data = (result && result.result) || {};
    if (data.code === 0) {
      res.json(data.data || {});
    } else {
      res.status(500).json({ error: data.msg || data.error || '云函数返回异常', code: data.code });
    }
  } catch (e) {
    console.error('[BranchRanking] 云函数调用失败:', e.message, e.stack || '');
    res.status(500).json({ error: '云函数调用失败: ' + (e.message || '未知'), stack: String(e.stack || '').split('\n').slice(0, 3).join('\n') });
  }
});

// ==================== 启动 ====================
const PORT = process.env.PORT || 3000;

// 标准学校种子数据
var SEED_BRANCHES = [
  { schoolId: 'GDUT',  schoolName: '广工',     branchCode: 'GDUT',  branchName: '广工',     shortName: '广工',     status: 'active' },
  { schoolId: 'SCAU',  schoolName: '华农',     branchCode: 'SCAU',  branchName: '华农',     shortName: '华农',     status: 'active' },
  { schoolId: 'SZIIT', schoolName: '深信',     branchCode: 'SZIIT', branchName: '深信',     shortName: '深信',     status: 'active' },
  { schoolId: 'HLXY',  schoolName: '华立',     branchCode: 'HLXY',  branchName: '华立',     shortName: '华立',     status: 'active' },
  { schoolId: 'GIBT',  schoolName: '广工商',   branchCode: 'GIBT',  branchName: '广工商',   shortName: '广工商',   status: 'active' },
  { schoolId: 'GDPU',  schoolName: '广药',     branchCode: 'GDPU',  branchName: '广药',     shortName: '广药',     status: 'active' },
  { schoolId: 'HNUFE', schoolName: '湖南涉外', branchCode: 'HNUFE', branchName: '湖南涉外', shortName: '湖南涉外', status: 'active' },
  { schoolId: 'GDMEC', schoolName: '广机电',   branchCode: 'GDMEC', branchName: '广机电',   shortName: '广机电',   status: 'active' },
  { schoolId: 'GZUCM', schoolName: '广中药',   branchCode: 'GZUCM', branchName: '广中药',   shortName: '广中药',   status: 'active' }
];

// 确保分点种子数据存在
async function seedBranches() {
  try {
    var { total } = await db.collection('branches').where({ status: 'active' }).count();
    if (total === 0) {
      console.log('[启动] 初始化标准分点数据...');
      for (var i = 0; i < SEED_BRANCHES.length; i++) {
        var b = SEED_BRANCHES[i];
        b.createdAt = new Date();
        b.updatedAt = new Date();
        b.address = '';
        b.contactName = '';
        b.contactPhone = '';
        b.admins = [];
        await db.collection('branches').add(b);
      }
      console.log('[启动] 已初始化 ' + SEED_BRANCHES.length + ' 个分点');
    } else {
      console.log('[启动] 分点数据已存在 (' + total + ' 个)，检查缺失...');
      // 增量添加种子数据中缺失的分点
      var addedCount = 0;
      for (var j = 0; j < SEED_BRANCHES.length; j++) {
        var seed = SEED_BRANCHES[j];
        var { data: existing } = await db.collection('branches').where({ schoolId: seed.schoolId }).get();
        if (!existing || existing.length === 0) {
          seed.createdAt = new Date();
          seed.updatedAt = new Date();
          seed.address = '';
          seed.contactName = '';
          seed.contactPhone = '';
          seed.admins = [];
          await db.collection('branches').add(seed);
          addedCount++;
          console.log('[启动] 新增分点: ' + seed.schoolName);
        }
      }
      if (addedCount > 0) console.log('[启动] 共新增 ' + addedCount + ' 个分点');
    }
  } catch (e) {
    console.warn('[启动] 分点种子数据初始化失败:', e.message);
  }
}

// 同步环境变量中的分点账号到数据库（管理页面可见）
async function seedBranchAdmins() {
  try {
    if (!BRANCH_ADMINS_STR) return;
    var pairs = BRANCH_ADMINS_STR.split(';').filter(Boolean);
    if (!pairs.length) return;
    var updated = 0, created = 0;
    for (var i = 0; i < pairs.length; i++) {
      var parts = pairs[i].split(':');
      if (parts.length !== 2) continue;
      var school = parts[0].trim();
      var pwd = parts[1].trim();
      if (!school || !pwd) continue;
      var { data: existing } = await db.collection('branch_admins').where({ school: school }).get();
      existing = Array.isArray(existing) ? existing : [];
      if (existing.length > 0) {
        await db.collection('branch_admins').doc(existing[0]._id).update({ password: pwd, updated_at: new Date() });
        updated++;
      } else {
        await db.collection('branch_admins').add({ school: school, password: pwd, status: 1, created_at: new Date(), updated_at: new Date() });
        created++;
      }
    }
    if (created > 0 || updated > 0) {
      console.log('[启动] 分点账号已同步：新建 ' + created + ' 个，更新 ' + updated + ' 个');
    }
  } catch (e) {
    console.warn('[启动] 分点账号同步失败:', e.message);
  }
}

// 确保云数据库集合存在（首次部署时自动创建）
async function ensureCollections() {
  const requiredCollections = ['sys_config', 'auto_export_logs', 'home_hot_products', 'branches', 'device_reservations', 'stock_warning_rules', 'device_transfers', 'transfer_rules', 'counters', 'sales_products', 'accessories', 'sales_cart', 'sales_orders', 'exchange_products', 'exchange_orders', 'exchange_coupons', 'point_logs', 'exp_logs', 'lottery_activities', 'lottery_prizes', 'lottery_records', 'lottery_daily_quota', 'user_prizes', 'anniversary_config', 'order_delivery_voucher', 'seckill_sessions', 'seckill_products'];
  for (var i = 0; i < requiredCollections.length; i++) {
    var name = requiredCollections[i];
    try {
      await db.createCollection(name);
      console.log('[启动] 集合 ' + name + ' 已创建');
    } catch (e1) {
      // 集合已存在（createCollection 失败属于正常），无需插入假数据
      // 之前每重启一次就 add({_init:true})，造成 home_hot_products 等集合积累大量垃圾记录
      console.log('[启动] 集合 ' + name + ' 已存在，跳过初始化');
    }
  }
  // 初始化售卖订单号计数器（SAL + ACC 序列）
  try {
    var counters = await db.collection('counters').get();
    var existingIds = (counters.data||[]).map(function(c){ return c._id; });
    if (!existingIds.includes('sales_order')) await db.collection('counters').add({ _id: 'sales_order', seq: 0 });
    if (!existingIds.includes('accessory_order')) await db.collection('counters').add({ _id: 'accessory_order', seq: 0 });
  } catch (e) { /* counters 集合可能尚未创建 */ }

  // 初始化分点种子数据 + 加载名称→ID 映射缓存
  await seedBranches();
  await seedBranchAdmins();
  await loadBranchMap();
}

// ==================== 履约凭证管理 API ====================

// 查询订单履约凭证列表
app.get('/api/orders/delivery-vouchers', authRequired, async (req, res) => {
  try {
    var { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });

    // 分点权限校验
    var orderDoc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(orderDoc.data) ? orderDoc.data[0] : orderDoc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限查看此订单' });

    var { data: list } = await db.collection('order_delivery_voucher')
      .where({ order_id: orderId }).orderBy('created_at', 'asc').get();
    list = Array.isArray(list) ? list : [];

    // 转换 cloud:// 为临时链接
    var cloudFiles = [];
    list.forEach(function(v) {
      if (v.voucher_url && v.voucher_url.startsWith('cloud://')) {
        cloudFiles.push(v.voucher_url);
      }
    });
    if (cloudFiles.length > 0) {
      try {
        var tempRes = await tcb.getTempFileURL({ fileList: cloudFiles });
        var urlMap = {};
        (tempRes.fileList || []).forEach(function(item, idx) {
          if (item.tempFileURL) urlMap[cloudFiles[idx]] = item.tempFileURL;
        });
        list.forEach(function(v) {
          if (urlMap[v.voucher_url]) v.temp_url = urlMap[v.voucher_url];
        });
      } catch (e) { /* 转换失败不阻塞 */ }
    }

    res.json({ list });
  } catch (e) { hideError(res, e); }
});

// 审核凭证（通过/退回）
app.post('/api/orders/delivery-vouchers/review', authRequired, async (req, res) => {
  try {
    var { voucherId, action, note } = req.body;
    if (!voucherId || !action) return res.status(400).json({ error: '缺少参数' });

    var vDoc = await db.collection('order_delivery_voucher').doc(voucherId).get();
    var voucher = Array.isArray(vDoc.data) ? vDoc.data[0] : vDoc.data;
    if (!voucher) return res.status(400).json({ error: '凭证记录不存在' });
    if (voucher.review_status !== 'pending') return res.status(400).json({ error: '该凭证已审核' });

    // 校验订单权限
    var orderDoc = await db.collection('orders').doc(voucher.order_id).get();
    var order = Array.isArray(orderDoc.data) ? orderDoc.data[0] : orderDoc.data;
    if (!order) return res.status(400).json({ error: '关联订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    var updateData = {
      review_status: action === 'approve' ? 'approved' : 'rejected',
      review_note: note || (action === 'approve' ? '审核通过' : '审核不通过'),
      reviewed_by: req.adminRole === 'super' ? 'super' : (req.adminSchool || 'branch'),
      reviewed_at: new Date()
    };
    await db.collection('order_delivery_voucher').doc(voucherId).update(updateData);

    // 审核通过后推进订单状态
    // ★ 修复：不区分面交/邮寄，只要是 send/receive 节点且订单仍在待发货(status=3)，
    //        审核通过即推进到租赁中(status=4)。归还节点不改变主状态。
    if (action === 'approve') {
      var nodeType = voucher.node_type;
      if ((nodeType === 'send' || nodeType === 'receive') && Number(order.status) === 3) {
        await db.collection('orders').doc(voucher.order_id).update({
          status: 4, orderStatus: 'renting', deviceStatus: 'delivered', updated_at: new Date()
        });
      }
    }

    res.json({ msg: action === 'approve' ? '凭证审核通过' : '凭证已退回' });
  } catch (e) { hideError(res, e); }
});

// ★ 批量审核归还凭证（一次操作覆盖全部凭证，替代单张审核）
app.post('/api/orders/delivery-vouchers/review-batch', authRequired, async (req, res) => {
  try {
    var { orderId, nodeType, action, note } = req.body;
    if (!orderId || !nodeType || !action) return res.status(400).json({ error: '缺少参数（orderId / nodeType / action）' });

    // 校验订单权限
    var orderDoc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(orderDoc.data) ? orderDoc.data[0] : orderDoc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    // 查询该节点所有待审核凭证
    var { data: pendingVouchers } = await db.collection('order_delivery_voucher')
      .where({ order_id: orderId, node_type: nodeType, review_status: 'pending' }).get();
    var pvList = Array.isArray(pendingVouchers) ? pendingVouchers : [];
    if (pvList.length === 0) {
      return res.status(400).json({ error: '没有待审核的凭证' });
    }

    var reviewer = req.adminRole === 'super' ? 'super' : (req.adminSchool || 'branch');
    var now = new Date();
    var reviewStatus = action === 'approve' ? 'approved' : 'rejected';
    var reviewNote = note || (action === 'approve' ? '审核通过' : '审核不通过');

    // 批量更新所有凭证
    for (var pv of pvList) {
      await db.collection('order_delivery_voucher').doc(pv._id).update({
        review_status: reviewStatus,
        review_note: reviewNote,
        reviewed_by: reviewer,
        reviewed_at: now
      });
    }

    // 审核通过后推进订单状态
    // ★ 修复：不区分面交/邮寄，只要是 send/receive 节点且订单仍在待发货(status=3)，
    //        审核通过即推进到租赁中(status=4)。归还节点不改变主状态。
    if (action === 'approve') {
      if ((nodeType === 'send' || nodeType === 'receive') && Number(order.status) === 3) {
        await db.collection('orders').doc(orderId).update({
          status: 4, orderStatus: 'renting', deviceStatus: 'delivered', updated_at: now
        });
      }
    }

    // 记录操作日志
    try {
      await db.collection('admin_logs').add({
        action: 'batch_review_voucher',
        order_id: orderId,
        node_type: nodeType,
        review_status: reviewStatus,
        count: pvList.length,
        reviewed_by: reviewer,
        created_at: now
      });
    } catch (eLog) { /* 日志不阻塞 */ }

    res.json({
      msg: (action === 'approve' ? '✅ 已通过 ' : '❌ 已退回 ') + pvList.length + ' 张凭证',
      count: pvList.length
    });
  } catch (e) { hideError(res, e); }
});

// 强制跳过节点（商家跳过凭证审核，直接推进订单）
app.post('/api/orders/delivery-vouchers/skip', authRequired, async (req, res) => {
  try {
    var { orderId, nodeType } = req.body;
    if (!orderId || !nodeType) return res.status(400).json({ error: '缺少参数' });

    var orderDoc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(orderDoc.data) ? orderDoc.data[0] : orderDoc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    // 将该节点所有 pending 凭证标记为强制跳过
    var { data: pendingVouchers } = await db.collection('order_delivery_voucher')
      .where({ order_id: orderId, node_type: nodeType, review_status: 'pending' }).get();
    var pvList = Array.isArray(pendingVouchers) ? pendingVouchers : [];
    var now = new Date();
    for (var pv of pvList) {
      await db.collection('order_delivery_voucher').doc(pv._id).update({
        review_status: 'approved',
        review_note: '商家强制跳过',
        reviewed_by: req.adminRole === 'super' ? 'super' : (req.adminSchool || 'branch'),
        reviewed_at: now
      });
    }

    // 推进订单状态
    if (nodeType === 'send' || nodeType === 'receive') {
      await db.collection('orders').doc(orderId).update({
        status: 4, orderStatus: 'renting', deviceStatus: 'delivered', updated_at: now
      });
    }
    // 归还跳过不改变主状态

    res.json({ msg: '已强制跳过「' + (nodeType === 'send' ? '发货' : nodeType === 'receive' ? '收货' : '归还') + '」节点，订单已推进' });
  } catch (e) { hideError(res, e); }
});

// 从审核不通过的凭证一键创建理赔单（关联现有 order_insurances 表）
app.post('/api/orders/delivery-vouchers/create-claim', authRequired, async (req, res) => {
  try {
    var { voucherId, orderId, claimNote } = req.body;
    if (!voucherId || !orderId) return res.status(400).json({ error: '缺少参数' });

    var orderDoc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(orderDoc.data) ? orderDoc.data[0] : orderDoc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    // 查询凭证信息
    var vDoc = await db.collection('order_delivery_voucher').doc(voucherId).get();
    var voucher = Array.isArray(vDoc.data) ? vDoc.data[0] : vDoc.data;
    if (!voucher) return res.status(400).json({ error: '凭证记录不存在' });

    // 创建理赔记录（复用现有 order_insurances 集合）
    var claimData = {
      order_id: orderId,
      _openid: order._openid || '',
      plan_name: '履约异常理赔',
      price: 0,
      coverage_desc: '履约凭证审核异常 - ' + (voucher.node_type === 'send' ? '发货节点' : voucher.node_type === 'receive' ? '收货节点' : '归还节点'),
      apply_type: 'damage',
      status: 2,  // 审核中
      claim_reason: claimNote || ('凭证审核不通过：' + (voucher.review_note || '异常')),
      claim_imgs: voucher.voucher_url ? [voucher.voucher_url] : [],
      claimed_at: new Date(),
      voucher_id: voucherId
    };
    var addResult = await db.collection('order_insurances').add(claimData);

    // 回写凭证关联理赔ID
    await db.collection('order_delivery_voucher').doc(voucherId).update({
      claim_id: addResult.id || ''
    });

    res.json({ msg: '理赔单已创建，请前往理赔管理处理', claimId: addResult.id || '' });
  } catch (e) { hideError(res, e); }
});

// ==================== 售卖管理 API ====================

// ---------- 整机售卖商品 ----------
app.get('/api/sales-products', authRequired, async (req, res) => {
  try {
    let where = {};
    if (req.adminRole === 'branch') {
      where.branch_id = req.adminBranchId || '';
    }
    const { data: list } = await db.collection('sales_products').where(where).orderBy('created_at', 'desc').get();
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

app.post('/api/sales-products/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    const { productId, name, model, specs, price, stock, images,
      inspection_no, imei, cosmetic_grade, function_grade,
      battery_health, battery_capacity, is_repaired,
      purchase_channel, warranty_expire, source,
      network_type, ios_version } = req.body;
    if (!name || !price) return res.status(400).json({ error: '商品名称和价格必填' });
    var data = {
      name, model: model || '', specs: specs || '',
      price: parseFloat(price) || 0, stock: parseInt(stock) || 0,
      images: images || [],
      inspection_no: inspection_no || '', imei: imei || '',
      cosmetic_grade: cosmetic_grade || '', function_grade: function_grade || '',
      battery_health: battery_health || '', battery_capacity: battery_capacity || '',
      is_repaired: is_repaired || '',
      purchase_channel: purchase_channel || '', warranty_expire: warranty_expire || '',
      source: source || '', network_type: network_type || '', ios_version: ios_version || '',
      status: 1, updated_at: new Date()
    };
    if (productId) {
      await db.collection('sales_products').doc(productId).update(data);
    } else {
      data.created_at = new Date();
      await db.collection('sales_products').add(data);
    }
    await loadBranchMap();
    res.json({ msg: '已保存' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/sales-products/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    const { productId, status } = req.body;
    await db.collection('sales_products').doc(productId).update({ status: status ? 1 : 0, updated_at: new Date() });
    res.json({ msg: status ? '已上架' : '已下架' });
  } catch (e) { hideError(res, e); }
});

// ---------- 配件管理 ----------
app.get('/api/accessories', authRequired, async (req, res) => {
  try {
    let where = {};
    if (req.adminRole === 'branch') {
      where.branch_id = req.adminBranchId || '';
    }
    const { data: list } = await db.collection('accessories').where(where).orderBy('created_at', 'desc').get();
    res.json({ list });
  } catch (e) { hideError(res, e); }
});

app.post('/api/accessories/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    const { accessoryId, name, category, price, stock, images, specs } = req.body;
    if (!name || !price) return res.status(400).json({ error: '配件名称和价格必填' });
    var data = {
      name, category: category || '', specs: specs || '',
      price: parseFloat(price) || 0, stock: parseInt(stock) || 0,
      images: images || [],
      status: 1, updated_at: new Date()
    };
    if (accessoryId) {
      await db.collection('accessories').doc(accessoryId).update(data);
    } else {
      data.created_at = new Date();
      await db.collection('accessories').add(data);
    }
    res.json({ msg: '已保存' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/accessories/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    const { accessoryId, status } = req.body;
    await db.collection('accessories').doc(accessoryId).update({ status: status ? 1 : 0, updated_at: new Date() });
    res.json({ msg: status ? '已上架' : '已下架' });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 智能客服卡片桥接（解析 AI 回复中的卡片标记 → 微信客服消息）
// ═══════════════════════════════════════════════════════════════

// 智能客服桥接
const kefuBridge = (() => {
  try { return require('../server/middleware/customerServiceBridge'); }
  catch (e) { console.warn('[KefuBridge] 模块加载失败:', e.message); return null; }
})();

// 注入 CloudBase 实例（让桥接模块能查询商品图片 + 解析 cloud:// URL）
// db 和 tcb 在前文已初始化
if (kefuBridge) {
  kefuBridge.setDb(db);
  kefuBridge.setTcb(tcb);
}

// 简化版：接收 AI 回复文本 → 解析卡片 → 发送微信客服消息
// POST /api/kefu/reply
// Body: { openid: "用户OpenID", aiResponse: "AI回复文本（可含卡片标记）" }
app.post('/api/kefu/reply', async (req, res) => {
  try {
    if (!kefuBridge) {
      return res.status(500).json({ error: 'customerServiceBridge 模块未加载' });
    }
    const { openid, aiResponse } = req.body;
    if (!openid || !aiResponse) {
      return res.status(400).json({ error: '缺少 openid 或 aiResponse' });
    }
    const result = await kefuBridge.dispatchReply(openid, aiResponse);
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error('[KefuReply] 异常:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// 上传卡片缩略图到微信素材库（获取 thumb_media_id）
// POST /api/kefu/upload-thumb  (multipart/form-data, 字段名: image)
// 或 GET /api/kefu/upload-thumb?url=https://xxx.jpg (通过URL上传)
app.post('/api/kefu/upload-thumb', async (req, res) => {
  try {
    // GET 方式：通过 url 参数指定图片 URL
    let imageBuffer, contentType;
    const imageUrl = req.query.url;
    if (imageUrl) {
      const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      imageBuffer = Buffer.from(resp.data);
      contentType = resp.headers['content-type'] || 'image/jpeg';
    } else {
      // POST 方式：从 multipart 表单中读取文件
      return res.status(400).json({
        error: '请使用 GET 方式并传入 url 参数：/api/kefu/upload-thumb?url=https://图片地址.jpg',
        example: '/api/kefu/upload-thumb?url=https://yijiquan-xxx.tcb.qcloud.la/logo.png'
      });
    }

    // 获取 access_token
    const { getAccessToken } = require('../server/utils/wechat');
    const token = await getAccessToken();

    // 上传到微信临时素材库（3天有效，客服消息足够）
    const FormData = require('form-data');
    const form = new FormData();
    form.append('media', imageBuffer, {
      filename: 'thumb_' + Date.now() + '.jpg',
      contentType: contentType
    });

    const uploadUrl = 'https://api.weixin.qq.com/cgi-bin/media/upload?access_token=' + token + '&type=image';
    const { data } = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 20000
    });

    if (data.errcode) {
      return res.status(400).json({ error: '上传失败', errcode: data.errcode, errmsg: data.errmsg });
    }

    console.log('[KefuUpload] 缩略图上传成功, media_id:', data.media_id);
    return res.json({
      success: true,
      media_id: data.media_id,
      expires_in: '3天（临时素材）',
      tip: '请将此 media_id 设置为环境变量 WECHAT_THUMB_MEDIA_ID，或填入云函数 customerServiceBridge 的配置中',
      env_guide: data.media_id ? 'WECHAT_THUMB_MEDIA_ID=' + data.media_id : ''
    });
  } catch (e) {
    console.error('[KefuUpload] 异常:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// 批量预上传所有商品图到微信素材库（首次部署时执行一次即可）
// GET /api/kefu/batch-upload-thumbs
app.get('/api/kefu/batch-upload-thumbs', async (req, res) => {
  try {
    if (!kefuBridge) return res.status(500).json({ error: 'customerServiceBridge 模块未加载' });
    if (!kefuBridge.getDb()) return res.status(500).json({ error: '数据库未注入，请先设置 _dbGetter' });

    const result = await kefuBridge.batchUploadAllProductImages();
    return res.json({
      success: true,
      uploaded: result.uploaded,
      failed: result.failed,
      total: result.uploaded + result.failed,
      mapping: result.mapping,
      tip: '商品图已上传到微信素材库(3天有效)。无需额外配置，桥接模块会自动使用对应商品图。'
    });
  } catch (e) {
    console.error('[BatchUpload] 异常:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// 测试用：直接发送一张小程序卡片到指定用户
// POST /api/kefu/send-card
// Body: { openid: "用户OpenID", title: "卡片标题", path: "pages/index/index" }
app.post('/api/kefu/send-card', async (req, res) => {
  try {
    if (!kefuBridge) {
      return res.status(500).json({ error: 'customerServiceBridge 模块未加载' });
    }
    const { openid, title, path } = req.body;
    if (!openid || !title || !path) {
      return res.status(400).json({ error: '缺少 openid、title 或 path' });
    }
    const ok = await kefuBridge.sendMiniProgramCard(openid, title, path);
    return res.json({ success: ok });
  } catch (e) {
    console.error('[KefuSendCard] 异常:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// 阿里百炼 API 代理：小程序端直接调此接口获取 AI 回复
// POST /api/kefu/chat
// Body: { openid: "用户OpenID", message: "用户消息" }
app.post('/api/kefu/chat', async (req, res) => {
  try {
    if (!kefuBridge) {
      return res.status(500).json({ error: 'customerServiceBridge 模块未加载' });
    }
    const { openid, message } = req.body;
    if (!openid || !message) {
      return res.status(400).json({ error: '缺少 openid 或 message' });
    }

    // 调用阿里百炼
    const aiResponse = await kefuBridge.callBailian(message);

    // 如果有 AI 回复，解析卡片并发送客服消息
    if (aiResponse) {
      const result = await kefuBridge.dispatchReply(openid, aiResponse);
      return res.json({ success: true, reply: aiResponse, ...result });
    }

    return res.json({ success: false, reply: '' });
  } catch (e) {
    console.error('[KefuChat] 异常:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// 积分兑换商品管理
// ═══════════════════════════════════════════════════════════════
app.get('/api/exchange-products', authRequired, async (req, res) => {
  try {
    var { data: list } = await db.collection('exchange_products').orderBy('points', 'asc').get();
    res.json({ list: Array.isArray(list) ? list : [] });
  } catch (e) { hideError(res, e); }
});

app.post('/api/exchange-products/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    var { productId, name, type, points, coupon_amount, coupon_min_order,
          coupon_discount, coupon_max_discount, coupon_valid_days,
          applicable_scope, stock, image } = req.body;
    if (!name || !type || points == null) return res.status(400).json({ error: '名称、类型和积分必填' });
    var data = {
      name, type,
      points: Number(points) || 0,
      coupon_amount: Number(coupon_amount) || 0,
      coupon_min_order: Number(coupon_min_order) || 0,
      coupon_discount: coupon_discount != null ? Number(coupon_discount) : undefined,
      coupon_max_discount: Number(coupon_max_discount) || 0,
      coupon_valid_days: Number(coupon_valid_days) || 7,
      applicable_scope: applicable_scope || 'all',
      stock: stock != null ? Number(stock) : -1,
      image: image || '',
      updated_at: new Date()
    };
    if (productId) {
      await db.collection('exchange_products').doc(productId).update(data);
    } else {
      data.status = 1;
      data.created_at = new Date();
      await db.collection('exchange_products').add(data);
    }
    res.json({ msg: '已保存' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/exchange-products/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    var { productId } = req.body;
    var doc = await db.collection('exchange_products').doc(productId).get();
    var p = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    var newStatus = p.status === 1 ? 0 : 1;
    await db.collection('exchange_products').doc(productId).update({ status: newStatus, updated_at: new Date() });
    res.json({ msg: newStatus === 1 ? '已上架' : '已下架' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/exchange-products/delete', async (req, res) => {
  try {
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少ID' });
    await db.collection('exchange_products').doc(id).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 兑换订单管理
// ═══════════════════════════════════════════════════════════════
app.get('/api/exchange-orders', authRequired, async (req, res) => {
  try {
    var { status, type, page = 1, pageSize = 20 } = req.query;
    var where = {};
    if (status) where.status = status;
    if (type) where.product_type = type;
    var { data: list } = await db.collection('exchange_orders').where(where)
      .skip((Number(page) - 1) * Number(pageSize)).limit(Number(pageSize))
      .orderBy('created_at', 'desc').get();
    var { total } = await db.collection('exchange_orders').where(where).count();
    res.json({ list: Array.isArray(list) ? list : [], total, page: Number(page), pageSize: Number(pageSize) });
  } catch (e) { hideError(res, e); }
});

app.post('/api/exchange-orders/process', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    var { orderId, action, tracking_company, tracking_no } = req.body;
    if (!orderId || !action) return res.status(400).json({ error: '缺少参数' });
    var updateData = { updated_at: new Date() };
    if (action === 'complete') {
      updateData.status = 'completed';
    } else if (action === 'ship') {
      updateData.status = 'shipped';
      updateData.tracking_company = tracking_company || '';
      updateData.tracking_no = tracking_no || '';
    } else if (action === 'cancel') {
      updateData.status = 'cancelled';
    } else {
      return res.status(400).json({ error: '无效操作: ' + action });
    }
    await db.collection('exchange_orders').doc(orderId).update(updateData);
    res.json({ msg: '已处理' });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 积分流水查询
// ═══════════════════════════════════════════════════════════════
app.get('/api/point-logs', authRequired, async (req, res) => {
  try {
    var { userId, type, page = 1, pageSize = 50 } = req.query;
    var where = {};
    if (userId) where._openid = userId;
    if (type) where.type = type;
    var { data: list } = await db.collection('point_logs').where(where)
      .skip((Number(page) - 1) * Number(pageSize)).limit(Number(pageSize))
      .orderBy('created_at', 'desc').get();
    var { total } = await db.collection('point_logs').where(where).count();
    res.json({ list: Array.isArray(list) ? list : [], total, page: Number(page), pageSize: Number(pageSize) });
  } catch (e) { hideError(res, e); }
});

// ---------- 售卖订单管理 ----------
app.get('/api/sales-orders', authRequired, async (req, res) => {
  try {
    const { status, page = 1, pageSize = 20 } = req.query;
    let conditions = [];
    if (req.adminRole === 'branch') {
      conditions.push({ branchId: req.adminBranchId || req.adminSchool });
    }
    if (status) conditions.push({ status: status });
    let where = conditions.length > 0 ? _.and(conditions) : {};
    const { data: list } = await db.collection('sales_orders').where(where)
      .skip((page - 1) * pageSize).limit(Number(pageSize))
      .orderBy('created_at', 'desc').get();
    const { total } = await db.collection('sales_orders').where(where).count();
    res.json({ list, total, page: Number(page), pageSize: Number(pageSize) });
  } catch (e) { hideError(res, e); }
});

app.get('/api/sales-orders/detail', authRequired, async (req, res) => {
  try {
    const { orderId } = req.query;
    const doc = await db.collection('sales_orders').doc(orderId).get();
    const order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    res.json({ order });
  } catch (e) { hideError(res, e); }
});

app.post('/api/sales-orders/ship', authRequired, async (req, res) => {
  try {
    const { orderId, tracking } = req.body;
    await db.collection('sales_orders').doc(orderId).update({
      status: 'shipped', tracking: tracking || '', updated_at: new Date()
    });
    res.json({ msg: '已标记发货' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/sales-orders/cancel', authRequired, async (req, res) => {
  try {
    const { orderId } = req.body;
    const doc = await db.collection('sales_orders').doc(orderId).get();
    const order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (order.status !== 'pending_payment') return res.status(400).json({ error: '仅待付款订单可取消' });
    // 归还库存
    if (order.items) {
      for (const item of order.items) {
        var collName = order.order_type === 'accessory' ? 'accessories' : 'sales_products';
        try { await db.collection(collName).doc(item.product_id).update({ stock: _.inc(item.quantity || 1) }); } catch (e) {}
      }
    }
    await db.collection('sales_orders').doc(orderId).update({
      status: 'cancelled', paymentStatus: 'unpaid', updated_at: new Date()
    });
    res.json({ msg: '订单已取消' });
  } catch (e) { hideError(res, e); }
});

app.post('/api/sales-orders/complete', authRequired, async (req, res) => {
  try {
    const { orderId } = req.body;
    await db.collection('sales_orders').doc(orderId).update({
      status: 'completed', updated_at: new Date()
    });
    res.json({ msg: '已完成' });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 月度自动导出订单
// ═══════════════════════════════════════════════════════════════

// 判断是否为当月最后一天（自动适配大小月、2月闰年）
function isLastDayOfMonth(date) {
  var d = new Date(date);
  var tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  return tomorrow.getDate() === 1;  // 明天是 1 号 → 今天是最后一天
}

// 初始化自动导出配置（从 DB 加载到内存）
async function initAutoExportConfig() {
  try {
    var { data } = await db.collection('sys_config').doc('auto_export').get();
    var doc = Array.isArray(data) ? data[0] : data;
    if (doc) {
      autoExportConfig.enabled = doc.enabled !== false;
      autoExportConfig.export_path = doc.export_path || 'D:\\weixin\\csv';
      console.log('[启动] auto_export 配置已加载:', JSON.stringify(autoExportConfig));
    } else {
      await db.collection('sys_config').add({
        _id: 'auto_export',
        enabled: true,
        export_path: 'D:\\weixin\\csv',
        updated_at: new Date()
      });
      console.log('[启动] auto_export 默认配置已初始化');
    }
  } catch (e) {
    console.warn('[启动] auto_export 配置加载失败（使用内存默认值）:', e.message);
  }
}

// 核心：执行自动导出
async function runAutoExport(triggerType) {
  if (isExporting) {
    console.log('[auto-export] 上一次导出尚未完成，跳过本次执行');
    return { ok: false, msg: '上一次导出尚未完成，跳过' };
  }
  isExporting = true;
  var startTime = Date.now();
  var logEntry = {
    executed_at: new Date(),
    trigger_type: triggerType || 'unknown',
    order_count: 0,
    file_path: '',
    status: 'error',
    error_message: '',
    duration_ms: 0
  };

  try {
    // 生成月度文件名
    var now = new Date();
    var yyyy = now.getFullYear();
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    var filename = '易机圈_已完成订单_' + yyyy + mm + '.csv';
    var dirPath = autoExportConfig.export_path || 'D:\\weixin\\csv';
    var filePath = path.join(dirPath, filename);

    // 递归创建目录（Windows 兼容）
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log('[auto-export] 已创建导出目录:', dirPath);
    }

    // 调用共享 CSV 生成函数（仅已完成订单）
    var { csv, orderCount } = await generateOrdersCSV({
      status: '5',
      source: '',
      role: 'super',
      school: ''
    });

    // 写入文件（UTF-8 + BOM，与手动导出完全一致）
    fs.writeFileSync(filePath, csv, 'utf8');

    logEntry.status = 'success';
    logEntry.order_count = orderCount;
    logEntry.file_path = filePath;
    console.log('[auto-export] 导出成功: ' + filePath + ' (' + orderCount + ' 条订单)');
  } catch (e) {
    logEntry.error_message = e.message || String(e);
    console.error('[auto-export] 导出失败:', e.message);
  } finally {
    logEntry.duration_ms = Date.now() - startTime;
    try {
      await db.collection('auto_export_logs').add(logEntry);
    } catch (dbErr) {
      console.error('[auto-export] 日志记录失败:', dbErr.message);
    }
    isExporting = false;
  }

  return { ok: logEntry.status === 'success', msg: logEntry.status === 'success' ? ('导出成功: ' + logEntry.order_count + ' 条') : ('导出失败: ' + logEntry.error_message) };
}

// --- API 端点 ---

// 读取配置
app.get('/api/auto-export/config', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    res.json(autoExportConfig);
  } catch (e) { hideError(res, e); }
});

// 保存配置
app.post('/api/auto-export/config', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    var { enabled, export_path } = req.body;
    var updates = { updated_at: new Date() };
    if (typeof enabled === 'boolean') { autoExportConfig.enabled = enabled; updates.enabled = enabled; }
    if (typeof export_path === 'string' && export_path.trim()) {
      autoExportConfig.export_path = export_path.trim();
      updates.export_path = export_path.trim();
    }
    try {
      await db.collection('sys_config').doc('auto_export').update(updates);
    } catch (dbErr) {
      // 若文档不存在则创建
      if (dbErr.message && dbErr.message.indexOf('not found') > -1) {
        await db.collection('sys_config').add(Object.assign({ _id: 'auto_export' }, autoExportConfig, { updated_at: new Date() }));
      } else { throw dbErr; }
    }
    res.json({ msg: '已保存', config: autoExportConfig });
  } catch (e) { hideError(res, e); }
});

// 手动触发导出（测试按钮）
app.post('/api/auto-export/trigger', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    if (!autoExportConfig.enabled) {
      return res.json({ msg: '自动导出已关闭，请先启用后再触发测试' });
    }
    // 异步执行，即时返回
    setImmediate(function() { runAutoExport('manual'); });
    res.json({ msg: '导出任务已触发，请稍后查看执行日志' });
  } catch (e) { hideError(res, e); }
});

// 查询执行日志
app.get('/api/auto-export/logs', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅总号可操作' });
    var { data: logs } = await db.collection('auto_export_logs')
      .orderBy('executed_at', 'desc').limit(100).get();
    res.json({ list: Array.isArray(logs) ? logs : [] });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 幸运转盘抽奖活动管理
// ═══════════════════════════════════════════════════════════════

// 活动状态统一判断（与云函数 drawLottery/getLotteryActivity 保持一致）
function resolveActivityStatus(activity, now) {
  if (!activity) return 'disabled';
  if (activity.status === 'paused') return 'paused';
  if (activity.status === 'ended') return 'ended';
  if (activity.status === 'sold_out') return 'sold_out';
  // 显式布尔转换，防止 CloudBase 返回 0/1 等非布尔值
  if (!Boolean(activity.isEnabled)) return 'disabled';

  var startTime = activity.startTime ? new Date(activity.startTime) : null;
  var endTime = activity.endTime ? new Date(activity.endTime) : null;
  now = now || new Date();

  if (startTime && now < startTime) return 'not_started';
  if (endTime && now > endTime) return 'ended';
  return 'active';
}

// 列表（含实时状态解析）
app.get('/api/lottery-activities', authRequired, async (req, res) => {
  try {
    var { status, page = 1, pageSize = 50 } = req.query;
    var where = {};
    if (status) where.status = status;
    var { data: list } = await db.collection('lottery_activities').where(where)
      .skip((Number(page) - 1) * Number(pageSize)).limit(Number(pageSize))
      .orderBy('createdAt', 'desc').get();
    var { total } = await db.collection('lottery_activities').where(where).count();
    list = Array.isArray(list) ? list : [];
    // 实时解析状态，确保前后端一致
    var now = new Date();
    list = list.map(function(a) {
      a._resolvedStatus = resolveActivityStatus(a, now);
      return a;
    });
    res.json({ list: list, total, page: Number(page), pageSize: Number(pageSize) });
  } catch (e) { hideError(res, e); }
});

// 单个活动详情（含奖品）
app.get('/api/lottery-activities/detail', authRequired, async (req, res) => {
  try {
    var { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少活动ID' });
    var doc = await db.collection('lottery_activities').doc(id).get();
    var activity = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!activity) return res.status(400).json({ error: '活动不存在' });
    var { data: prizes } = await db.collection('lottery_prizes')
      .where({ activityId: id }).orderBy('sort', 'asc').get();
    activity.prizes = Array.isArray(prizes) ? prizes : [];
    res.json({ activity });
  } catch (e) { hideError(res, e); }
});

// 新建/编辑活动
app.post('/api/lottery-activities/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { _id, title, coverImage, startTime, endTime, isEnabled, showOnHome,
          rules, drawLimitPerUser, requirePhoneLogin, requireVerified, onlyMember,
          autoEndWhenSoldOut, weeklyFreeEnabled, weeklyFreeDays, weeklyFreeCountPerDay,
          pointsDrawEnabled, pointsPerDraw } = req.body;
    if (!title) return res.status(400).json({ error: '活动名称必填' });

    // 显式布尔转换（防止前端传来字符串 "true"/"false"）
    var enabled = Boolean(isEnabled);
    var showHome = Boolean(showOnHome);
    var verified = Boolean(requireVerified);
    var member = Boolean(onlyMember);
    var autoEnd = autoEndWhenSoldOut !== false;

    // 状态处理：编辑时保留终止态，新建/非终止态才重新计算
    var status;
    var existingActivity = null;
    if (_id) {
      try {
        var doc = await db.collection('lottery_activities').doc(_id).get();
        existingActivity = Array.isArray(doc.data) ? doc.data[0] : doc.data;
      } catch (e) { /* 新建活动，忽略 */ }
    }

    var terminalStatuses = ['ended', 'sold_out'];
    if (existingActivity && terminalStatuses.indexOf(existingActivity.status) >= 0) {
      // 已结束/已抽完的活动编辑后保持原状态，不自动重置
      status = existingActivity.status;
    } else if (!enabled) {
      status = existingActivity ? (existingActivity.status || 'paused') : 'paused';
    } else {
      var tmpActivity = { isEnabled: true, startTime: startTime, endTime: endTime, status: 'active' };
      status = resolveActivityStatus(tmpActivity, new Date());
    }

    // datetime-local 格式无时区，补 +08:00 确保云函数（UTC环境）时间判断正确
    var fmtStart = startTime ? (startTime.length === 16 ? startTime + ':00+08:00' : startTime) : '';
    var fmtEnd = endTime ? (endTime.length === 16 ? endTime + ':00+08:00' : endTime) : '';

    var data = {
      title: title,
      coverImage: coverImage || '',
      startTime: fmtStart,
      endTime: fmtEnd,
      status: status,
      isEnabled: enabled,
      showOnHome: showHome,
      rules: rules || '',
      drawLimitPerUser: Number(drawLimitPerUser) || 1,
      requirePhoneLogin: requirePhoneLogin !== false,
      requireVerified: verified,
      onlyMember: member,
      autoEndWhenSoldOut: autoEnd,
      // —— 周周期免费抽奖 + 积分兑换抽奖配置 ——
      weeklyFreeEnabled: Boolean(weeklyFreeEnabled),
      weeklyFreeDays: Array.isArray(weeklyFreeDays) ? weeklyFreeDays.map(Number).filter(function (d) { return d >= 1 && d <= 7; }) : [],
      weeklyFreeCountPerDay: Number(weeklyFreeCountPerDay) || 1,
      pointsDrawEnabled: Boolean(pointsDrawEnabled),
      pointsPerDraw: Number(pointsPerDraw) || 10,
      updatedAt: new Date()
    };

    if (_id) {
      await db.collection('lottery_activities').doc(_id).update(data);
      res.json({ msg: '活动已更新', _id: _id });
    } else {
      data.createdAt = new Date();
      var addRes = await db.collection('lottery_activities').add(data);
      res.json({ msg: '活动已创建', _id: addRes._id });
    }
  } catch (e) { hideError(res, e); }
});

// 删除活动
app.post('/api/lottery-activities/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少活动ID' });
    await db.collection('lottery_activities').doc(id).remove();
    // 同时删除关联的奖品
    await db.collection('lottery_prizes').where({ activityId: id }).remove().catch(function(){});
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// 切换活动状态（启用/禁用/暂停/结束）
app.post('/api/lottery-activities/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id, action } = req.body;
    if (!id) return res.status(400).json({ error: '缺少活动ID' });

    var statusMap = {
      'enable': 'active',
      'disable': 'paused',
      'pause': 'paused',
      'end': 'ended',
      'resume': 'active'
    };
    var newStatus = statusMap[action];
    if (!newStatus) return res.status(400).json({ error: '无效操作: ' + action });

    var updateData = { status: newStatus, updatedAt: new Date() };
    if (action === 'disable') updateData.isEnabled = false;
    if (action === 'enable') updateData.isEnabled = true;

    await db.collection('lottery_activities').doc(id).update(updateData);
    res.json({ msg: '状态已更新为: ' + newStatus });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 奖品配置
// ═══════════════════════════════════════════════════════════════

// 获取活动奖品列表
app.get('/api/lottery-prizes', authRequired, async (req, res) => {
  try {
    var { activityId } = req.query;
    if (!activityId) return res.status(400).json({ error: '缺少活动ID' });
    var { data: list } = await db.collection('lottery_prizes')
      .where({ activityId: activityId }).orderBy('sort', 'asc').get();
    res.json({ list: Array.isArray(list) ? list : [] });
  } catch (e) { hideError(res, e); }
});

// 新建/编辑奖品
app.post('/api/lottery-prizes/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { _id, activityId, prizeLevel, prizeName, prizeType, totalStock, remainStock,
          probability, sort, isEnabled, validType, validStartTime, validEndTime,
          validDaysAfterReceive, couponConfig, experienceCardConfig } = req.body;

    if (!activityId) return res.status(400).json({ error: '缺少活动ID' });
    if (!prizeName) return res.status(400).json({ error: '奖品名称必填' });

    var stock = Number(totalStock) || 0;
    var data = {
      activityId: activityId,
      prizeLevel: prizeLevel || '',
      prizeName: prizeName,
      prizeType: prizeType || 'thanks',
      totalStock: stock,
      remainStock: remainStock !== undefined ? Number(remainStock) : stock,
      probability: Number(probability) || 0,
      sort: Number(sort) || 0,
      isEnabled: isEnabled !== false,
      validType: validType || 'limited',
      validStartTime: validStartTime || '',
      validEndTime: validEndTime || '',
      validDaysAfterReceive: Number(validDaysAfterReceive) || 0,
      couponConfig: couponConfig || {},
      experienceCardConfig: experienceCardConfig || {},
      updatedAt: new Date()
    };

    if (_id) {
      await db.collection('lottery_prizes').doc(_id).update(data);
      res.json({ msg: '奖品已更新', _id: _id });
    } else {
      // 新奖品：未指定排序时自动放到末尾
      if (!data.sort) {
        var { data: maxList } = await db.collection('lottery_prizes')
          .where({ activityId: activityId }).orderBy('sort', 'desc').limit(1).get();
        data.sort = (maxList && maxList.length > 0) ? (maxList[0].sort || 0) + 1 : 1;
      }
      data.createdAt = new Date();
      var addRes = await db.collection('lottery_prizes').add(data);
      res.json({ msg: '奖品已添加', _id: addRes._id });
    }
  } catch (e) { hideError(res, e); }
});

// 删除奖品
app.post('/api/lottery-prizes/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少奖品ID' });
    await db.collection('lottery_prizes').doc(id).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// 切换奖品启用状态
app.post('/api/lottery-prizes/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少奖品ID' });
    var doc = await db.collection('lottery_prizes').doc(id).get();
    var p = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!p) return res.status(400).json({ error: '奖品不存在' });
    await db.collection('lottery_prizes').doc(id).update({ isEnabled: !p.isEnabled, updatedAt: new Date() });
    res.json({ msg: p.isEnabled ? '已禁用' : '已启用' });
  } catch (e) { hideError(res, e); }
});

// 奖品排序（上移/下移，交换 sort 值）
app.post('/api/lottery-prizes/reorder', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id, direction } = req.body;
    if (!id) return res.status(400).json({ error: '缺少奖品ID' });
    var dir = Number(direction) || 0;
    if (dir !== -1 && dir !== 1) return res.status(400).json({ error: 'direction 必须为 -1(上移) 或 1(下移)' });

    // 获取当前奖品
    var current = await db.collection('lottery_prizes').doc(id).get();
    var cur = Array.isArray(current.data) ? current.data[0] : current.data;
    if (!cur) return res.status(404).json({ error: '奖品不存在' });

    // 获取同活动下所有启用的奖品，按 sort 排序
    var { data: siblings } = await db.collection('lottery_prizes')
      .where({ activityId: cur.activityId })
      .orderBy('sort', 'asc')
      .get();
    siblings = siblings || [];

    // 找到当前奖品在排序列表中的位置
    var curIdx = -1;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i]._id === id) { curIdx = i; break; }
    }
    if (curIdx < 0) return res.status(404).json({ error: '奖品不在列表中' });

    // 计算目标索引
    var targetIdx = curIdx + dir;
    if (targetIdx < 0 || targetIdx >= siblings.length) {
      return res.status(400).json({ error: '已到边界，无法移动' });
    }

    var target = siblings[targetIdx];
    var curSort = cur.sort || 0;
    var targetSort = target.sort || 0;

    // 交换两个奖品的 sort 值
    await db.collection('lottery_prizes').doc(id).update({ sort: targetSort, updatedAt: new Date() });
    await db.collection('lottery_prizes').doc(target._id).update({ sort: curSort, updatedAt: new Date() });

    res.json({ msg: '排序已更新' });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 中奖记录管理
// ═══════════════════════════════════════════════════════════════

// 中奖记录列表
app.get('/api/lottery-records', authRequired, async (req, res) => {
  try {
    var { activityId, prizeType, issueStatus, userPhone, page = 1, pageSize = 50 } = req.query;
    var where = {};
    if (activityId) where.activityId = activityId;
    if (prizeType) where.prizeType = prizeType;
    if (issueStatus) where.issueStatus = issueStatus;
    if (userPhone) where.userPhone = userPhone;
    var { data: list } = await db.collection('lottery_records').where(where)
      .skip((Number(page) - 1) * Number(pageSize)).limit(Number(pageSize))
      .orderBy('drawTime', 'desc').get();
    var { total } = await db.collection('lottery_records').where(where).count();
    res.json({ list: Array.isArray(list) ? list : [], total, page: Number(page), pageSize: Number(pageSize) });
  } catch (e) { hideError(res, e); }
});

// 更新中奖记录状态
app.post('/api/lottery-records/update', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id, issueStatus, status, staffRemark } = req.body;
    if (!id) return res.status(400).json({ error: '缺少记录ID' });
    var updateData = { updatedAt: new Date() };
    if (issueStatus !== undefined) updateData.issueStatus = issueStatus;
    if (status !== undefined) updateData.status = status;
    if (staffRemark !== undefined) updateData.staffRemark = staffRemark;
    await db.collection('lottery_records').doc(id).update(updateData);
    res.json({ msg: '已更新' });
  } catch (e) { hideError(res, e); }
});

// 手动补发奖品
app.post('/api/lottery-records/reissue', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少记录ID' });

    var doc = await db.collection('lottery_records').doc(id).get();
    var record = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!record) return res.status(400).json({ error: '记录不存在' });
    if (record.issueStatus === 'issued') return res.status(400).json({ error: '已发放，不可重复补发' });

    // 重新执行发放逻辑（简化版：仅标记为已发放，实际发放由工作人员手动完成）
    await db.collection('lottery_records').doc(id).update({
        issueStatus: 'issued',
        status: 'drawn',
        staffRemark: (record.staffRemark || '') + ' [手动补发]',
        updatedAt: new Date()
    });
    res.json({ msg: '已标记为已发放' });
  } catch (e) { hideError(res, e); }
});

// 删除抽奖记录（调试用：重置用户抽奖次数）
app.post('/api/lottery-records/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id, openid, activityId } = req.body;

    if (id) {
      await db.collection('lottery_records').doc(id).remove();
      return res.json({ msg: '已删除' });
    }

    if (openid && activityId) {
      var { data: records } = await db.collection('lottery_records')
        .where({ openid: openid, activityId: activityId }).get();
      if (!records || records.length === 0) {
        return res.status(404).json({ error: '未找到抽奖记录' });
      }
      for (var i = 0; i < records.length; i++) {
        await db.collection('lottery_records').doc(records[i]._id).remove();
      }
      return res.json({ msg: '已删除 ' + records.length + ' 条抽奖记录，抽奖次数已重置' });
    }

    res.status(400).json({ error: '请提供 id 或 (openid + activityId)' });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 周年庆活动配置管理（P0 基础配置接口）
// ═══════════════════════════════════════════════════════════════

// 查询当前活动配置（始终返回最新一条）
app.get('/api/anniversary-config', authRequired, async (req, res) => {
  try {
    var { data: list } = await db.collection('anniversary_config')
      .orderBy('updatedAt', 'desc').limit(1).get();
    var cfg = (Array.isArray(list) && list.length > 0) ? list[0] : null;
    res.json({ config: cfg });
  } catch (e) { hideError(res, e); }
});

// 保存活动配置（创建或更新）
app.post('/api/anniversary-config/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var {
      _id, isEnabled, startTime, endTime, bannerImage, rules,
      showLottery, showCouponCenter, showSeckill, showSceneSelect,
      showRanking, showAmbassador
    } = req.body;

    var data = {
      isEnabled: !!isEnabled,
      startTime: startTime || '',
      endTime: endTime || '',
      bannerImage: bannerImage || '',
      rules: rules || '',
      showLottery: !!showLottery,
      showCouponCenter: !!showCouponCenter,
      showSeckill: !!showSeckill,
      showSceneSelect: !!showSceneSelect,
      showRanking: !!showRanking,
      showAmbassador: !!showAmbassador,
      status: 1,
      updatedAt: new Date()
    };

    if (_id) {
      // 更新现有配置
      await db.collection('anniversary_config').doc(_id).update(data);
      res.json({ msg: '活动配置已更新', _id: _id });
    } else {
      // 新建配置
      data.createdAt = new Date();
      var result = await db.collection('anniversary_config').add(data);
      res.json({ msg: '活动配置已创建', _id: result.id });
    }
  } catch (e) { hideError(res, e); }
});

// 上传 Banner 图片（使用 CloudBase 云存储，与 /api/upload 一致）
app.post('/api/anniversary-config/upload', authRequired, upload.single('file'), async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    if (!req.file) return res.status(400).json({ error: '请选择图片文件' });

    // 格式校验
    var ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','webp'].indexOf(ext) === -1) {
      return res.status(400).json({ error: '仅支持 jpg、png、webp 格式图片' });
    }

    // 上传到 CloudBase 云存储
    var cloudPath = 'anniversary/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    var result = await tcb.uploadFile({ cloudPath: cloudPath, fileContent: req.file.buffer });
    var fileID = result.fileID;

    // 获取临时下载链接（浏览器可直接渲染）
    var tempRes = await tcb.getTempFileURL({ fileList: [fileID] });
    var tempUrl = (tempRes.fileList && tempRes.fileList[0] && tempRes.fileList[0].tempFileURL) || fileID;

    res.json({ url: fileID, fileID: fileID, tempUrl: tempUrl });
  } catch (e) { hideError(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// 预留接口占位：后续8个周年庆活动模块
// 以下接口为架构预埋，后续开发时直接填充业务逻辑
// ═══════════════════════════════════════════════════════════════

// 【预留-待开发】抽奖转盘管理
// 入参：{ action: 'list'|'config'|'prizes', ... }
// app.get('/api/anniversary-lottery', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-lottery/save', authRequired, async (req, res) => { ... });

// 【预留-待开发】领券中心管理
// app.get('/api/anniversary-coupons', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-coupons/save', authRequired, async (req, res) => { ... });

// 【预留-待开发】秒杀活动管理
// app.get('/api/anniversary-seckill', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-seckill/save', authRequired, async (req, res) => { ... });

// 【预留-待开发】邀请排行榜
// app.get('/api/anniversary-ranking', authRequired, async (req, res) => { ... });

// 【预留-待开发】邀请海报管理
// app.get('/api/anniversary-poster', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-poster/save', authRequired, async (req, res) => { ... });

// 【预留-待开发】场景选机配置
// app.get('/api/anniversary-scene', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-scene/save', authRequired, async (req, res) => { ... });

// 【预留-待开发】录取季配置
// app.get('/api/anniversary-admission', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-admission/save', authRequired, async (req, res) => { ... });

// 【预留-待开发】校园大使管理
// app.get('/api/anniversary-ambassador', authRequired, async (req, res) => { ... });
// app.post('/api/anniversary-ambassador/save', authRequired, async (req, res) => { ... });

// ═══════════════════════════════════════════════════════════════
// 秒杀活动管理（场次 + 商品）
// ═══════════════════════════════════════════════════════════════

// ====== 秒杀场次 ======

// 场次列表
app.get('/api/seckill-sessions', authRequired, async (req, res) => {
  try {
    var { data: list } = await db.collection('seckill_sessions').orderBy('sort', 'asc').get();
    list = list || [];
    var now = new Date();
    list.forEach(function (s) {
      var st = parseSeckillTime(s.startTime);
      var et = parseSeckillTime(s.endTime);
      if (!st || !et) { s._resolvedStatus = 'unknown'; return; }
      if (now < st) s._resolvedStatus = 'not_started';
      else if (now >= st && now <= et) s._resolvedStatus = 'active';
      else s._resolvedStatus = 'ended';
    });
    res.json({ list: list, total: list.length });
  } catch (e) { hideError(res, e); }
});

// 保存场次（新建/编辑）
app.post('/api/seckill-sessions/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { _id, title, startTime, endTime, limitPerUser, sort } = req.body;
    if (!title) return res.status(400).json({ error: '场次名称必填' });
    var data = {
      title: title.trim(),
      startTime: startTime || '',
      endTime: endTime || '',
      limitPerUser: parseInt(limitPerUser) || 1,
      sort: parseInt(sort) || 0,
      status: 1,
      updated_at: new Date()
    };
    if (_id) {
      await db.collection('seckill_sessions').doc(_id).update(data);
      res.json({ msg: '场次已更新', _id: _id });
    } else {
      data.created_at = new Date();
      var result = await db.collection('seckill_sessions').add(data);
      res.json({ msg: '场次已创建', _id: result.id });
    }
  } catch (e) { hideError(res, e); }
});

// 删除场次
app.post('/api/seckill-sessions/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少场次ID' });
    await db.collection('seckill_sessions').doc(id).remove();
    // 同时删除关联的秒杀商品
    await db.collection('seckill_products').where({ sessionId: id }).remove().catch(function () { });
    res.json({ msg: '场次已删除' });
  } catch (e) { hideError(res, e); }
});

// 切换场次状态（上架/下架）
app.post('/api/seckill-sessions/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少场次ID' });
    var doc = await db.collection('seckill_sessions').doc(id).get();
    var s = doc.data && doc.data.length > 0 ? doc.data[0] : (doc.data || null);
    if (!s) return res.status(400).json({ error: '场次不存在' });
    var newStatus = s.status === 1 ? 0 : 1;
    await db.collection('seckill_sessions').doc(id).update({ status: newStatus, updated_at: new Date() });
    res.json({ msg: newStatus === 1 ? '已上架' : '已下架', status: newStatus });
  } catch (e) { hideError(res, e); }
});

// ====== 秒杀商品 ======

// 商品列表（按场次）
app.get('/api/seckill-products', authRequired, async (req, res) => {
  try {
    var sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: '缺少场次ID' });
    var { data: list } = await db.collection('seckill_products')
      .where({ sessionId: sessionId })
      .orderBy('sort', 'asc').get();
    res.json({ list: list || [] });
  } catch (e) { hideError(res, e); }
});

// 保存秒杀兑换券（新建/编辑）— 商品专属兑换券模式
app.post('/api/seckill-products/save', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { _id, sessionId, productId, productName, productImage, originalPrice, exchangePrice, validDays, rentalDays, totalStock, sort } = req.body;
    if (!sessionId) return res.status(400).json({ error: '缺少场次ID' });
    if (!productId) return res.status(400).json({ error: '请选择商品' });
    if (!exchangePrice || parseFloat(exchangePrice) <= 0) return res.status(400).json({ error: '秒杀兑换价必填且必须大于0' });
    var rd = parseInt(rentalDays) || 0;
    if (!rd || rd <= 0) return res.status(400).json({ error: '秒杀租期必填且必须大于0' });
    var origPrice = parseFloat(originalPrice) || 0;
    var exPrice = parseFloat(exchangePrice) || 0;
    var data = {
      sessionId: sessionId,
      productId: productId,
      productName: productName || '',
      productImage: productImage || '',
      originalPrice: origPrice,
      // 兑换券字段：兑换价为固定租期的总租金
      exchangePrice: exPrice,
      rentalDays: rd,
      afterCouponPrice: exPrice,  // 券后参考价 = 兑换价（同步，只读）
      validDays: parseInt(validDays) || 7,
      totalStock: parseInt(totalStock) || 0,
      soldCount: parseInt(req.body.soldCount) || 0,
      status: 1,
      sort: parseInt(sort) || 0,
      updated_at: new Date()
    };
    if (_id) {
      await db.collection('seckill_products').doc(_id).update(data);
      res.json({ msg: '秒杀兑换券已更新', _id: _id });
    } else {
      data.created_at = new Date();
      var result = await db.collection('seckill_products').add(data);
      res.json({ msg: '秒杀兑换券已添加', _id: result.id });
    }
  } catch (e) { hideError(res, e); }
});

// 删除秒杀商品
app.post('/api/seckill-products/delete', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少商品ID' });
    await db.collection('seckill_products').doc(id).remove();
    res.json({ msg: '已删除' });
  } catch (e) { hideError(res, e); }
});

// 切换秒杀商品状态
app.post('/api/seckill-products/toggle', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') return res.status(403).json({ error: '仅主管理员可操作' });
    var { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少商品ID' });
    var doc = await db.collection('seckill_products').doc(id).get();
    var p = doc.data && doc.data.length > 0 ? doc.data[0] : (doc.data || null);
    if (!p) return res.status(400).json({ error: '商品不存在' });
    var newStatus = p.status === 1 ? 0 : 1;
    await db.collection('seckill_products').doc(id).update({ status: newStatus, updated_at: new Date() });
    res.json({ msg: newStatus === 1 ? '已上架' : '已下架' });
  } catch (e) { hideError(res, e); }
});

// ====== 辅助 ======
function parseSeckillTime(str) {
  if (!str) return null;
  if (str.indexOf('+') > -1 || str.indexOf('Z') > -1 || (str.length > 16 && str.indexOf('-', 8) > -1)) {
    return new Date(str);
  }
  return new Date(str + ':00+08:00');
}

// ═══════════════════════════════════════════════════════════════════════════
// 微信订单状态同步 — 异步调用 wxpayUploadOrder 云函数
// 用于发货/完成等关键节点后同步订单状态到微信订单管理，确保两侧状态对齐
// ═══════════════════════════════════════════════════════════════════════════
async function syncWxOrderStatus(orderNo, retries) {
  retries = retries || 0;
  var MAX_RETRIES = 3;

  if (!orderNo) {
    console.warn('[wxSync] 缺少订单号，跳过同步');
    return;
  }

  console.log('[wxSync] 开始同步订单到微信:', orderNo, retries > 0 ? '(重试' + retries + '/' + MAX_RETRIES + ')' : '');

  try {
    var callResult = await tcb.callFunction({
      name: 'wxpayUploadOrder',
      data: { order_no: orderNo }
    });

    var result = (callResult && callResult.result) || {};
    if (result.code === 0) {
      console.log('[wxSync] ✅ 订单同步成功:', orderNo, result.msg);
    } else if (result.code === 500 || result.code === 400) {
      // 可重试错误（网络、token等）
      if (retries < MAX_RETRIES) {
        var delay = Math.pow(2, retries) * 1000; // 1s, 2s, 4s 递增
        console.warn('[wxSync] ⚠️ 同步失败，' + delay + 'ms 后重试:', orderNo, result.msg || result.errmsg);
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
        await syncWxOrderStatus(orderNo, retries + 1);
      } else {
        console.error('[wxSync] ❌ 同步失败（已达最大重试次数）:', orderNo, result.msg || result.errmsg);
      }
    } else {
      console.log('[wxSync] 同步结果:', orderNo, result.msg || result.errmsg);
    }
  } catch (e) {
    if (retries < MAX_RETRIES) {
      var delay = Math.pow(2, retries) * 1000;
      console.warn('[wxSync] ⚠️ 调用异常，' + delay + 'ms 后重试:', orderNo, e.message);
      await new Promise(function (resolve) { setTimeout(resolve, delay); });
      await syncWxOrderStatus(orderNo, retries + 1);
    } else {
      console.error('[wxSync] ❌ 调用异常（已达最大重试次数）:', orderNo, e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 微信订单同步 — 手动/批量 API
// ═══════════════════════════════════════════════════════════════════════════

// 单笔手动同步微信订单状态
app.post('/api/orders/sync-wx-order', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super' && req.adminRole !== 'branch') {
      return res.status(403).json({ error: '无权限：仅管理员可操作' });
    }
    var { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: '缺少订单ID' });

    var doc = await db.collection('orders').doc(orderId).get();
    var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!order) return res.status(400).json({ error: '订单不存在' });
    if (!canAccessOrder(req, order)) return res.status(403).json({ error: '无权限操作此订单' });

    var orderNo = order.order_no || orderId;

    // 同步调用（不异步，确保返回结果给前端）
    try {
      var callResult = await tcb.callFunction({
        name: 'wxpayUploadOrder',
        data: { order_no: orderNo }
      });
      var result = (callResult && callResult.result) || {};
      console.log('[wxSync:manual] 手动同步结果:', orderNo, JSON.stringify(result));
      res.json({
        msg: result.code === 0 ? '同步成功' : ('同步结果: ' + (result.msg || '未知')),
        code: result.code,
        errcode: result.errcode,
        detail: result
      });
    } catch (e) {
      console.error('[wxSync:manual] 调用异常:', e.message);
      res.status(500).json({ error: '同步调用失败: ' + e.message });
    }
  } catch (e) { hideError(res, e); }
});

// 批量同步微信订单状态
app.post('/api/orders/sync-wx-order-batch', authRequired, async (req, res) => {
  try {
    if (req.adminRole !== 'super') {
      return res.status(403).json({ error: '无权限：仅主管理员可批量操作' });
    }
    var { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: '缺少订单ID列表' });
    }
    if (orderIds.length > 50) {
      return res.status(400).json({ error: '单次最多批量同步50个订单' });
    }

    var results = { total: orderIds.length, success: 0, failed: 0, skipped: 0, details: [] };

    for (var i = 0; i < orderIds.length; i++) {
      var oid = orderIds[i];
      try {
        var doc = await db.collection('orders').doc(oid).get();
        var order = Array.isArray(doc.data) ? doc.data[0] : doc.data;
        if (!order) {
          results.failed++;
          results.details.push({ orderId: oid, status: 'error', msg: '订单不存在' });
          continue;
        }
        if (!canAccessOrder(req, order)) {
          results.failed++;
          results.details.push({ orderId: oid, status: 'error', msg: '无权限' });
          continue;
        }

        var orderNo = order.order_no || oid;
        var callResult = await tcb.callFunction({
          name: 'wxpayUploadOrder',
          data: { order_no: orderNo }
        });
        var syncResult = (callResult && callResult.result) || {};

        if (syncResult.code === 0) {
          results.success++;
          results.details.push({ orderId: oid, order_no: orderNo, status: 'success', msg: syncResult.msg });
        } else {
          results.failed++;
          results.details.push({ orderId: oid, order_no: orderNo, status: 'failed', msg: syncResult.msg || syncResult.errmsg });
        }
      } catch (e) {
        results.failed++;
        results.details.push({ orderId: oid, status: 'error', msg: e.message });
      }
    }

    console.log('[wxSync:batch] 批量同步完成: 成功', results.success, '失败', results.failed);
    res.json(results);
  } catch (e) { hideError(res, e); }
});

// 启动服务器（确保 listen 不依赖 ensureCollections 成功与否）
async function startServer() {
  try {
    await ensureCollections();
    await initAutoExportConfig();
  } catch (e) {
    console.error('[启动] 集合初始化失败（不影响核心功能）:', e.message);
  }

  // 月度自动导出定时任务：每天 23:59 检查是否为当月最后一天
  cron.schedule('59 23 * * *', function () {
    if (!autoExportConfig.enabled) return;
    if (!isLastDayOfMonth(new Date())) return;
    runAutoExport('scheduled');
  });
  console.log('[启动] 月度自动导出已调度（每月最后一天 23:59，当前配置 ' + (autoExportConfig.enabled ? '已启用' : '已禁用') + '）');

  app.listen(PORT, () => {
    console.log(`\n✅ 商家管理后台已启动：http://localhost:${PORT}\n`);
    console.log(`   云环境：${CLOUD_ENV}`);
    console.log(`   学校映射：${Object.keys(schoolNameToIdMap).length} 条`);
    console.log(`   按 Ctrl+C 停止\n`);
  });
}
startServer();