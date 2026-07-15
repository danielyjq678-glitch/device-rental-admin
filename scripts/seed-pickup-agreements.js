require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cloudbase = require('@cloudbase/node-sdk');
var tcb = cloudbase.init({
  env: process.env.CLOUD_ENV,
  secretId: process.env.CLOUD_SECRET_ID,
  secretKey: process.env.CLOUD_SECRET_KEY
});
var db = tcb.database();

function ensureColl(name) {
  return new Promise(function (resolve) {
    db.createCollection(name).then(function () {
      console.log(name + ' 集合已创建');
      resolve();
    }).catch(function () {
      resolve();
    });
  });
}

function seedPickupPoints() {
  return db.collection('pickup_points').count().then(function (res) {
    if (res.total > 0) {
      console.log('自提点已存在: ' + res.total);
      return;
    }
    var points = [
      { name: '广东工业大学（龙洞校区）', sort: 1, status: 1, created_at: new Date() },
      { name: '华南农业大学（校本部）', sort: 2, status: 1, created_at: new Date() },
      { name: '广州工商学院（三水校区）', sort: 3, status: 1, created_at: new Date() },
      { name: '广东华立学院（江门校区）', sort: 4, status: 1, created_at: new Date() },
      { name: '广东机电职业技术学院（北校区）', sort: 5, status: 1, created_at: new Date() },
      { name: '深圳信息职业技术学院（校本部）', sort: 6, status: 1, created_at: new Date() },
      { name: '湖南涉外经济学院（校本部）', sort: 7, status: 1, created_at: new Date() }
    ];
    var tasks = points.map(function (p) { return db.collection('pickup_points').add(p); });
    return Promise.all(tasks).then(function () {
      console.log('自提点已初始化: ' + points.length);
    });
  }).catch(function (e) {
    console.error('自提点初始化失败:', e.message);
  });
}

function seedAgreements() {
  return db.collection('agreements').count().then(function (res) {
    if (res.total > 0) {
      console.log('协议已存在: ' + res.total);
      return;
    }
    var envId = process.env.CLOUD_ENV || 'cloud1-d0gtbh90x8d74a386';
    var docs = [
      { name: '《个人征信授权书》', url: 'cloud://' + envId + '.636c-cloud1-d0gtbh90x8d74a386-1438096015/agreements/个人征信授权书.docx', sort: 1, status: 1, created_at: new Date() },
      { name: '《确认签收单》', url: 'cloud://' + envId + '.636c-cloud1-d0gtbh90x8d74a386-1438096015/agreements/确认签收单.docx', sort: 2, status: 1, created_at: new Date() },
      { name: '《特别提示函》', url: 'cloud://' + envId + '.636c-cloud1-d0gtbh90x8d74a386-1438096015/agreements/特别提示函.docx', sort: 3, status: 1, created_at: new Date() },
      { name: '《仲裁协议书》', url: 'cloud://' + envId + '.636c-cloud1-d0gtbh90x8d74a386-1438096015/agreements/仲裁协议书.docx', sort: 4, status: 1, created_at: new Date() },
      { name: '《租赁物搭配品购买协议》', url: 'cloud://' + envId + '.636c-cloud1-d0gtbh90x8d74a386-1438096015/agreements/租赁物搭配品购买协议.docx', sort: 5, status: 1, created_at: new Date() },
      { name: '《租用服务协议》', url: 'cloud://' + envId + '.636c-cloud1-d0gtbh90x8d74a386-1438096015/agreements/租用服务协议.docx', sort: 6, status: 1, created_at: new Date() }
    ];
    var tasks = docs.map(function (d) { return db.collection('agreements').add(d); });
    return Promise.all(tasks).then(function () {
      console.log('协议已初始化: ' + docs.length);
    });
  }).catch(function (e) {
    console.error('协议初始化失败:', e.message);
  });
}

ensureColl('pickup_points')
  .then(function () { return ensureColl('agreements'); })
  .then(function () { return seedPickupPoints(); })
  .then(function () { return seedAgreements(); })
  .catch(function (e) { console.error(e); });
