module.exports = {
    "parserOptions": {
      "ecmaFeatures": {
        "jsx": true
      }
    },
    "extends": [
      "airbnb-base"
    ],
    "env": {
      "jest": true
    },
    "globals": {
      "expect": false
    },
    "rules": {
      "import/no-unresolved": 0,
      "import/no-extraneous-dependencies": 0,
      "import/extensions": 0,
      "import/prefer-default-export": 0,
      "max-len": 0,
      "symbol-description": 0,
      "no-nested-ternary": 0,
      "no-alert": 0,
      "no-console": 0,
      "no-plusplus": 0,
      "no-restricted-globals": 0,
      "no-underscore-dangle": [
        "error",
        {
          "allow": [
            "_fields",
            "__fts_ranks"
          ]
        }
      ],
      "no-param-reassign": [
        "error",
        {
          "props": false
        }
      ],
      "no-return-assign": [
        "error",
        "except-parens"
      ],
      "class-methods-use-this": 0,
      "prefer-destructuring": [
        "error",
        {
          "object": true,
          "array": false
        }
      ]
    }
  }
