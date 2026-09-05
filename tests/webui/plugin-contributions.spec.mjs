import {test,expect} from '@playwright/test';
const errors=new WeakMap();
test.beforeEach(async({page,request})=>{await request.post('/__test/reset-memory');const list=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(async({page})=>expect(errors.get(page)).toEqual([]));
test('unloading a feature removes its markup and listeners and reloading installs one copy',async({page,request})=>{
 await page.goto('/');await expect(page.locator('#architecture-panel-sources')).toHaveCount(1);
 await page.evaluate(()=>document.querySelector('[data-architecture-view="sources"]').click());await expect(page.locator('#architecture-screen')).toHaveClass(/open/);
 await request.post('/__test/ui-availability',{data:{id:'sources',enabled:false}});await expect(page.locator('#architecture-panel-sources')).toHaveCount(0);await expect(page.locator('[data-architecture-view="sources"]')).toBeHidden();await expect(page.locator('#architecture-screen')).not.toHaveClass(/open/);
 await request.post('/__test/ui-availability',{data:{id:'sources',enabled:true}});await expect(page.locator('#architecture-panel-sources')).toHaveCount(1);
 await request.post('/__test/ui-availability',{data:{id:'sources',enabled:true}});await expect(page.locator('#architecture-panel-sources')).toHaveCount(1);
 await expect(page.locator('#input')).toBeVisible();
});
test('chat shell starts with an empty capability list',async({page})=>{
 await page.route('**/ui/contributions',route=>route.fulfill({json:[]}));await page.goto('/');await expect(page.locator('body')).toHaveAttribute('data-cortex-ready','true');await expect(page.locator('#input')).toBeVisible();await expect(page.locator('#provider-select option')).toHaveCount(3);await expect(page.locator('.architecture-panel')).toHaveCount(0);await expect(page.locator('[data-section="files"]')).toBeHidden();
});
test('additional configuration and diagnostics views mount without editing the shell',async({page})=>{
 await page.goto('/');await expect(page.locator('#architecture-panel-configuration')).toHaveCount(1);await expect(page.locator('#architecture-panel-diagnostics')).toHaveCount(1);
 await page.evaluate(()=>document.querySelector('[data-architecture-view="diagnostics"]').click());await expect(page.locator('#architecture-panel-diagnostics')).toBeVisible();
});

test('assembled browser runtime boots the shared shell with plugin-owned administration',async({page})=>{
 await page.route('https://**',route=>route.abort());
 await page.goto('/__test/matbot-bundle');await page.getByLabel('Name',{exact:true}).fill('Fixture');await page.getByRole('combobox',{name:'Adapter'}).selectOption({index:2});await page.getByRole('button',{name:'Save & start'}).click();await expect(page.locator('#input')).toBeVisible();
 const providers=await page.evaluate(()=>window.matbotTransport.callTool('provider',{action:'list'}));expect(providers.providers.some(provider=>provider.name==='Fixture')).toBeTruthy();
 const contributions=await page.evaluate(()=>window.matbotTransport.uiContributions());expect(contributions.some(row=>row.id==='runtime'&&row.owner==='@matatbread/matbot-runtime-admin')).toBeTruthy();
});
