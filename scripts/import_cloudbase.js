// 导入飞书数据到 CloudBase products 集合
require('dotenv').config();

const cloudbase = require('@cloudbase/node-sdk');

const tcb = cloudbase.init({
  env: process.env.CLOUD_ENV || 'cloud1-d0gtbh90x8d74a386',
  secretId: process.env.CLOUD_SECRET_ID,
  secretKey: process.env.CLOUD_SECRET_KEY
});
const db = tcb.database();
const _ = db.command;

const products = [
  { name:'iPhone 7P',         cat_id:1, desc:'',       daily:10,  deposit:400,  insurance:'',       t3:8,  t7:6,  t14:6,  t30:150, t60:280,  t90:380  },
  { name:'iPhone xr',         cat_id:1, desc:'',       daily:17,  deposit:1000, insurance:'',       t3:15, t7:12, t14:11, t30:300, t60:550,  t90:760  },
  { name:'iPhone xsm',        cat_id:1, desc:'',       daily:18,  deposit:1100, insurance:'',       t3:16, t7:12, t14:12, t30:300, t60:550,  t90:760  },
  { name:'iPhone12p',         cat_id:1, desc:'',       daily:18,  deposit:1800, insurance:'',       t3:15, t7:12, t14:12, t30:360, t60:660,  t90:920  },
  { name:'iPhone15',          cat_id:1, desc:'',       daily:25,  deposit:3000, insurance:'',       t3:20, t7:18, t14:18, t30:500, t60:920,  t90:1280 },
  { name:'iPhone15plus',      cat_id:1, desc:'',       daily:25,  deposit:3000, insurance:'',       t3:20, t7:18, t14:18, t30:500, t60:920,  t90:1280 },
  { name:'iPhone15pm',        cat_id:1, desc:'',       daily:40,  deposit:5600, insurance:'20',     t3:35, t7:25, t14:24, t30:700, t60:1290, t90:1780 },
  { name:'iPhone16pro',       cat_id:1, desc:'',       daily:40,  deposit:5600, insurance:'20',     t3:35, t7:25, t14:24, t30:700, t60:1290, t90:1780 },
  { name:'vivoX200u',         cat_id:1, desc:'',       daily:55,  deposit:5000, insurance:'30',     t3:45, t7:30, t14:30, t30:900, t60:1660, t90:2300 },
  { name:'vivoX200u全能',     cat_id:1, desc:'',       daily:120, deposit:6500, insurance:'30',     t3:100,t7:60, t14:60, t30:1800,t60:3310, t90:4590 },
  { name:'vivoX200u镜头套装', cat_id:1, desc:'',       daily:50,  deposit:2000, insurance:'',       t3:30, t7:20, t14:20, t30:600, t60:1100, t90:1530 },
  { name:'vivoX300p',         cat_id:1, desc:'',       daily:80,  deposit:6000, insurance:'30',     t3:60, t7:40, t14:40, t30:1200,t60:2210, t90:3060 },
  { name:'vivoX300p全能',     cat_id:1, desc:'',       daily:140, deposit:7000, insurance:'30',     t3:100,t7:50, t14:50, t30:1500,t60:2760, t90:3820 },
  { name:'vivoX300p镜头套装', cat_id:1, desc:'',       daily:50,  deposit:2500, insurance:'30',     t3:30, t7:20, t14:20, t30:600, t60:1100, t90:1530 },
  { name:'三星s23u',          cat_id:1, desc:'',       daily:40,  deposit:3500, insurance:'20',     t3:30, t7:25, t14:24, t30:700, t60:1290, t90:1780 },
  { name:'大疆pocket3',       cat_id:2, desc:'',       daily:28,  deposit:2500, insurance:'',       t3:25, t7:20, t14:18, t30:400, t60:740,  t90:1020 },
  { name:'大疆action5pro',    cat_id:2, desc:'',       daily:25,  deposit:2000, insurance:'',       t3:22, t7:20, t14:18, t30:400, t60:740,  t90:1020 },
  { name:'佳能CCDixus130',    cat_id:3, desc:'',       daily:25,  deposit:2200, insurance:'',       t3:20, t7:15, t14:14, t30:400, t60:740,  t90:1020 },
  { name:'拍立得mini7+',      cat_id:4, desc:'',       daily:7,   deposit:400,  insurance:'',       t3:5,  t7:3,  t14:3,  t30:90,  t60:170,  t90:230  },
  { name:'拍立得sq1',         cat_id:4, desc:'',       daily:20,  deposit:900,  insurance:'',       t3:15, t7:10, t14:10, t30:300, t60:550,  t90:760  },
  { name:'拍立得mini7c',      cat_id:4, desc:'',       daily:7,   deposit:400,  insurance:'',       t3:5,  t7:3,  t14:3,  t30:90,  t60:170,  t90:230  },
  { name:'iPad2022p',         cat_id:5, desc:'保险细则：', daily:35, deposit:4500, insurance:'',    t3:30, t7:25, t14:25, t30:750, t60:1380, t90:1910 },
  { name:'iPad2020p',         cat_id:5, desc:'普通小彩点（小黑点不明显）的无需赔付，大面积斑点等明显损伤据实际情况，赔付30%-50%',daily:25, deposit:2500, insurance:'', t3:22, t7:18, t14:18, t30:540, t60:990, t90:1380 },
  { name:'华为matePad11.5',   cat_id:5, desc:'',       daily:15,  deposit:1000, insurance:'',       t3:13, t7:10, t14:10, t30:300, t60:550,  t90:760  },
];

async function main() {
  try {
    // 1. 删除所有旧商品
    console.log('🗑️  正在清空 CloudBase products 集合...');
    const { data: oldList } = await db.collection('products').limit(1000).get();
    const oldProducts = Array.isArray(oldList) ? oldList : [];
    console.log(`   找到 ${oldProducts.length} 条旧记录`);

    for (const p of oldProducts) {
      await db.collection('products').doc(p._id).remove();
    }
    console.log('   已清空');

    // 2. 导入新商品
    let count = 0;
    for (const item of products) {
      await db.collection('products').add({
        name: item.name,
        category_id: item.cat_id,
        description: item.desc,
        daily_price: item.daily,
        original_deposit: item.deposit,
        price_3d: item.t3,
        price_7d: item.t7,
        price_14d: item.t14,
        price_30d: item.t30,
        price_60d: item.t60,
        price_90d: item.t90,
        laser_insurance: item.insurance,
        stock: 1,
        status: 1,
        tags: '',
        images: [],
        carousel_img: [],
        created_at: new Date(),
        updated_at: new Date()
      });
      count++;
      console.log(`✅ ${item.name}`);
    }

    // 3. 验证
    const { data: newList } = await db.collection('products').count();
    console.log(`\n📊 导入完成: ${count} 个商品, CloudBase 共 ${newList.total} 条`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 失败:', e.message);
    process.exit(1);
  }
}

main();
