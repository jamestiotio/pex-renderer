module.exports = /* glsl */`
#ifdef USE_METALLIC_ROUGHNESS_WORKFLOW
  #ifdef USE_METALLIC_ROUGHNESS_MAP
    // R = ?, G = roughness, B = metallic
    uniform sampler2D uMetallicRoughnessMap;

    // TODO: sampling the same texture twice
    void getMetallic(inout PBRData data) {
      vec4 texelColor = texture2D(uMetallicRoughnessMap, vTexCoord0);
      data.metallic = texelColor.b;
      data.roughness = texelColor.g;
    }

    void getRoughness(inout PBRData data) {
      // NOP, already read in getMetallic
    }
  #else
    uniform float uMetallic;
    uniform float uRoughness;

    #ifdef USE_METALLIC_MAP
      uniform sampler2D uMetallicMap; //assumes linear, TODO: check gltf

      void getMetallic(inout PBRData data) {
        data.metallic = uMetallic * texture2D(uMetallicMap, vTexCoord0).r;
      }
    #else
      void getMetallic(inout PBRData data) {
        data.metallic = uMetallic;
      }
    #endif

    #ifdef USE_ROUGHNESS_MAP
      uniform sampler2D uRoughnessMap; //assumes linear, TODO: check glTF
      void getRoughness(inout PBRData data) {
        data.roughness = uRoughness * texture2D(uRoughnessMap, vTexCoord0).r + 0.01;
      }
    #else
      void getRoughness(inout PBRData data) {
        data.roughness = uRoughness + 0.01;
      }
    #endif
  #endif
#endif
`