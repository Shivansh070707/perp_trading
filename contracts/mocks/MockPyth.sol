// SPDX-License-Identifier: MIT
pragma solidity =0.8.27;
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract MockPythContract is MockPyth {
    constructor() MockPyth(1, 60) {}
}
