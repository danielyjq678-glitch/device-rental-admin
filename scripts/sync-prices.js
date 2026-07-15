// 从飞书价格表同步梯度价格到 CloudBase products 集合
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cloudbase = require('@cloudbase/node-sdk');

const { CLOUD_ENV, CLOUD_SECRET_ID, CLOUD_SECRET_KEY } = process.env;
const tcb = cloudbase.init({ env: CLOUD_ENV, secretId: CLOUD_SECRET_ID, secretKey: CLOUD_SECRET_KEY });
const db = tcb.database();

// 飞书价格表数据 [ID, 60天, 单天, 描述, 最低押金, 7天, 14天, 3天, 月租, 类别, 90天, 机器激光险, 机器型号, 机器序号, 押金]
const feishuData = [
  [null, 280, 10, null, 200, 6, 6, 8, 150, '手机', 380, null, 'iPhone 7P', null, 400],
  [null, 550, 17, null, 500, 12, 11, 15, 300, '手机', 760, null, 'iPhone xr', null, 1000],
  [null, 550, 18, null, 600, 12, 11, 16, 300, '手机', 760, null, 'iPhone xsm', null, 1100],
  [null, 660, 18, null, 900, 12, 12, 15, 360, '手机', 920, null, 'iPhone12p', null, 1800],
  [null, 920, 25, null, 2500, 18, 18, 20, 500, '手机', 1280, null, 'iPhone15', null, 3000],
  [null, 920, 25, null, 2500, 18, 18, 20, 500, '手机', 1280, null, 'iPhone15plus', null, 3000],
  [null, 1290, 40, null, 3000, 25, 24, 35, 700, '手机', 1780, '20', 'iPhone15pm', null, 5600],
  [null, 1290, 40, null, 3000, 25, 24, 35, 700, '手机', 1780, '20', 'iPhone16pro', null, 5600],
  [null, 1660, 55, null, 3000, 30, 30, 45, 900, '手机', 2300, '30', 'vivoX200u', null, 5000],
  [null, 3310, 120, null, 4500, 60, 60, 100, 1800, '手机', 4590, '30', 'vivoX200u全能', null, 6500],
  [null, 1100, 50, null, 1000, 20, 20, 30, 600, '手机', 1530, null, 'vivoX200u镜头套装', null, 2000],
  [null, 2210, 80, null, 4000, 40, 40, 60, 1200, '手机', 3060, '30', 'vivoX300p', null, 6000],
  [null, 2760, 140, null, 5000, 50, 50, 100, 1500, '手机', 3820, '30', 'vivoX300p全能', null, 7000],
  [null, 1100, 50, null, 1500, 20, 20, 30, 600, '手机', 1530, '30', 'vivoX300p镜头套装', null, 2500],
  [null, 1290, 40, null, 2500, 25, 24, 30, 700, '手机', 1780, '20', '三星s23u', null, 3500],
  [null, 740, 28, null, 1200, 20, 18, 25, 400, '云台相机', 1020, null, '大疆pocket3', null, 2500],
  [null, 740, 25, null, 1000, 20, 18, 22, 400, '云台相机', 1020, null, '大疆action5pro', null, 2000],
  [null, 740, 25, null, 1000, 15, 14, 20, 400, 'CCD', 1020, null, '佳能CCDixus130', null, 2200],
  [null, 170, 7, null, 200, 3, 3, 5, 90, '拍立得', 230, null, '拍立得mini7+', null, 400],
  [null, 550, 20, null, 400, 10, 10, 15, 300, '拍立得', 760, null, '拍立得sq1', null, 900],
  [null, 170, 7, null, 200, 3, 3, 5, 90, '拍立得', 230, null, '拍立得mini7c', null, 400],
  [null, 1380, 35, '保险细则：', 2200, 25, 25, 30, 750, '平板', 1910, null, 'iPad2022p', null, 4500],
  [null, 990, 25, '普通小彩点（小黑点不明显）的无需赔付，大面积斑点等明显损伤据实际情况，赔付30%-50%', 1250, 18, 18, 22, 540, '平板', 1380, null, 'iPad2020p', null, 2500],
  [null, 550, 15, null, 500, 10, 10, 13, 300, '平板', 760, null, '华为matePad11.5', null, 1000],
];

// 类别 -> category_id 映射
const catMap = { '手机': 1, '云台相机': 2, 'CCD': 3, '拍立得': 4, '平板': 5 };

async function main() {
  // 获取现有 products
  const { data: existing } = await db.collection('products').get();
  console.log('现有商品数:', existing.length);

  let created = 0, updated = 0;

  for (const row of feishuData) {
    const [, p60, p1, desc, minDep, p7, p14, p3, p30, cat, p90, insurance, modelName, , deposit] = row;

    const productData = {
      name: modelName,
      daily_price: p1,
      price_3d: p3,
      price_7d: p7,
      price_14d: p14,
      price_30d: p30,
      price_60d: p60,
      price_90d: p90,
      original_deposit: deposit,
      category_id: catMap[cat] || 1,
      description: desc || '',
      tags: cat,
      stock: 99,
      status: 1,
      updated_at: new Date()
    };

    // 按名称精确匹配
    const match = existing.find(p => p.name === modelName);

    if (match) {
      await db.collection('products').doc(match._id).update(productData);
      console.log('  更新:', modelName);
      updated++;
    } else {
      productData.created_at = new Date();
      await db.collection('products').add(productData);
      console.log('  新建:', modelName);
      created++;
    }
  }

  console.log(`\n同步完成: 新建 ${created}, 更新 ${updated}`);
}

main().catch(e => { console.error(e); process.exit(1); });
