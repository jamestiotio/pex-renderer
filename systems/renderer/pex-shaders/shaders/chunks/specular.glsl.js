export default /* glsl */ `
#ifdef USE_SPECULAR
  uniform float uSpecular;
  uniform vec3 uSpecularColor;

  #ifdef USE_SPECULAR_MAP
    uniform sampler2D uSpecularMap;

    #ifdef USE_SPECULAR_MAP_TEX_COORD_TRANSFORM
      uniform mat3 uSpecularMapTexCoordTransform;
    #endif

    void getSpecular(inout PBRData data) {
      #ifdef USE_SPECULAR_MAP_TEX_COORD_TRANSFORM
        vec2 texCoord = getTextureCoordinates(data, SPECULAR_MAP_TEX_COORD_INDEX, uSpecularMapTexCoordTransform);
      #else
        vec2 texCoord = getTextureCoordinates(data, SPECULAR_MAP_TEX_COORD_INDEX);
      #endif
      vec4 texelColor = texture2D(uSpecularMap, texCoord);

      data.specular = toLinear(uSpecular) * decode(texelColor, SRGB).a;
    }
  #else
    void getSpecular(inout PBRData data) {
      data.specular = toLinear(uSpecular);
    }
  #endif

  #ifdef USE_SPECULAR_COLOR_MAP
    uniform sampler2D uSpecularColorMap;

    #ifdef USE_SPECULAR_COLOR_MAP_TEX_COORD_TRANSFORM
      uniform mat3 uSpecularColorMapTexCoordTransform;
    #endif

    void getSpecularColor(inout PBRData data) {
      #ifdef USE_SPECULAR_COLOR_MAP_TEX_COORD_TRANSFORM
        vec2 texCoord = getTextureCoordinates(data, SPECULAR_COLOR_MAP_TEX_COORD_INDEX, uSpecularColorMapTexCoordTransform);
      #else
        vec2 texCoord = getTextureCoordinates(data, SPECULAR_COLOR_MAP_TEX_COORD_INDEX);
      #endif
      vec4 texelColor = texture2D(uSpecularColorMap, texCoord);

      data.specularColor = decode(vec4(uSpecularColor, 1.0), SRGB).rgb * decode(texelColor, SRGB).rgb;
    }
  #else
    void getSpecularColor(inout PBRData data) {
      data.specularColor = decode(vec4(uSpecularColor, 1.0), SRGB).rgb;
    }
  #endif
#endif
`;
