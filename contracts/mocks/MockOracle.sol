// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;

contract MockOracle {
    uint256 private price;

    constructor() {
        price = 1000 * 1e18; // Default price of 1000
    }

    function setPrice(uint256 _price) external {
        price = _price;
    }

    function getPrice() external view returns (uint256) {
        return price;
    }
}
