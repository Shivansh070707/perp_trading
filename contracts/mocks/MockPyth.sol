// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

contract MockPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    mapping(bytes32 => Price) public prices;

    function setPrice(bytes32 feedId, int64 newPrice) external {
        prices[feedId] = Price({
            price: newPrice,
            conf: 1,
            expo: -8, 
            publishTime: block.timestamp
        });
    }

    function getPriceUnsafe(
        bytes32 feedId
    ) external view returns (Price memory) {
        return prices[feedId];
    }
}
