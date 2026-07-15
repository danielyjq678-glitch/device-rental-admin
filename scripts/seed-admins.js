require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cloudbase = require('@cloudbase/node-sdk');
var tcb = cloudbase.init({
  env: process.env.CLOUD_ENV,
  secretId: process.env.CLOUD_SECRET_ID,
  secretKey: process.env.CLOUD_SECRET_KEY
});
var db = tcb.database();
var ADMIN_OPENID = 'oNYxn3cgU2ky27-3gy0tuNqcXb4E';

db.createCollection('admins').then(function () {
  console.log('admins 集合已创建');
}).catch(function () {}).then(function () {
  return db.collection('admins').where({ openid: ADMIN_OPENID }).count();
}).then(function (res) {
  if (res.total > 0) {
    console.log('管理员已存在，跳过');
    return;
  }
  return db.collection('admins').add({
    openid: ADMIN_OPENID,
    name: '超级管理员',
    status: 1,
    created_at: new Date()
  }).then(function () {
    console.log('管理员已添加: ' + ADMIN_OPENID);
  });
}).catch(function (e) {
  console.error(e);
});
