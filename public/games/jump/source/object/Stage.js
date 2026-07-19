import {
  Scene,
  Color,
  WebGLRenderer,
  Mesh,
  PlaneGeometry,
  ShadowMaterial,
  AmbientLight,
  DirectionalLight,
  OrthographicCamera,
  Vector2
} from 'three';

import {
  BACKGROUND_COLOR,
  WIDTH,
  HEIGHT,
  CLIENT_HEIGHT,
  CLIENT_WIDTH,
  FAR,
  LIGHT_COLOR
} from '../config/constant';

export default class Stage {

  constructor () {
    // 场景
    this.scene = null;
    // 地面
    this.plane = null;
    // 光照
    this.shadowLight = null;
    // 相机
    this.camera = null;
    // 渲染器
    this.renderer = null;
    this.init();
  }

  init() {
    // 初始化场景
    this.createScene();
    // 初始化渲染器
    this.createRenderer();
    // 初始化地面
    this.createPlane();
    // 初始化光照
    this.createLight();
    // 初始化相机
    this.createCamera();
  }

  // 场景
  createScene () {
    this.scene = new Scene();
    this.scene.updateMatrixWorld(true);
    this.scene.background = new Color(BACKGROUND_COLOR);
  }

  // 地面
  createPlane () {
    // 创建一个足够大的地面
    // 由于视角是 45 度向下看，地面会比实际的大，这里简单处理下
    const geometry = new PlaneGeometry(2 * FAR, 2 * FAR, 1, 1);
    // ShadowMaterial 阴影材质, 此材质可以接收阴影
    // transparent： 透明，在非透明对象之后渲染
    // opacity: 透明度
    const material = new ShadowMaterial({ transparent: true, opacity: 0.5});

    this.plane = new Mesh(geometry, material);
    // 接收阴影
    this.plane.receiveShadow = true;

    // 旋转 -90，此时地面处在 x-z 平面
    this.plane.rotation.x = -Math.PI / 2;

    this.scene.add(this.plane)
  }

  // 光源
  createLight() {
    // 环境光会均匀的照亮场景中的所有物体，它不能用来投射阴影，因为它没有方向
    const ambientLight = new AmbientLight(LIGHT_COLOR, 0.5);

    // 平行光，平行光可以投射阴影
    this.shadowLight = new DirectionalLight(LIGHT_COLOR, 0.5);
    // 设定光照源方向，目标默认是原点
    // 这个大小无意义，只代表方向
    this.shadowLight.position.set(FAR/6, FAR/2, FAR/6);
    // 开启阴影投射
    this.shadowLight.castShadow = true;

    // 定义可见域的投射阴影
    this.shadowLight.shadow.camera = new OrthographicCamera(-WIDTH*1.5, WIDTH*1.5, HEIGHT, -HEIGHT, 0, 2 * FAR);
    this.shadowLight.shadow.mapSize = new Vector2( 1024, 1024 );

    this.scene.add(ambientLight);
    this.scene.add(this.shadowLight);
  }

  // 相机
  createCamera () {
    // 相机使用正交相机
    // 相机是椎体的宽度和高度尽量和界面大小一致
    this.camera = new OrthographicCamera(-WIDTH/2, WIDTH/2, HEIGHT/2, -HEIGHT/2, -FAR/4, FAR*2);

    // 相机位置超过最大物体
    // 斜向右下看
    this.camera.position.set(-FAR/2, FAR/2, FAR/2);
    this.camera.lookAt(0, 0, 0);

  }

  // 渲染器
  createRenderer () {
    this.renderer = new WebGLRenderer({
      antialias:true // 抗锯齿
    });
    this.renderer.setSize(CLIENT_WIDTH, CLIENT_HEIGHT);
    document.body.appendChild(this.renderer.domElement );
    // 开启阴影
    this.renderer.shadowMap.enabled = true;
    // 设置设备像素
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }


  // 执行渲染
  render () {
    const {scene, camera, renderer} = this;
    renderer.render(scene, camera);
  }
}
