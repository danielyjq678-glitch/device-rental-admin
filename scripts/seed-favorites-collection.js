require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cloudbase = require('@cloudbase/node-sdk');
var tcb = cloudbase.init({
  env: process.env.CLOUD_ENV,
  secretId: process.env.CLOUD_SECRET_ID,
  secretKey: process.env.CLOUD_SECRET_KEY
});
var db = tcb.database();

db.createCollection('user_favorites').then(function () {
  console.log('user_favorites 集合已创建');
}).catch(function (e) {
  if (e && e.message && e.message.indexOf('already exist') > -1) {
    console.log('user_favorites 集合已存在，跳过');
  } else {
    console.log('创建集合失败（可能已存在）: ' + (e && e.message));
  }
}).then(function () {
  console.log('收藏集合迁移完成');
});
