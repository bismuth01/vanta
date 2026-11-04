// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Constant-product AMM (x*y=k, 0.30% fee) standing in for Kuru / Uniswap v4 on Monad.
///         This is the *public* venue: anything routed here is visible and sandwichable.
contract SimpleAMM {
    address public immutable base;
    address public immutable quote;
    uint256 public reserveBase;
    uint256 public reserveQuote;
    uint256 public constant FEE_BPS = 30;

    event Swap(address indexed sender, address tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(address base_, address quote_) {
        base = base_;
        quote = quote_;
    }

    /// @dev No LP accounting: demo liquidity is seeded once by the deployer.
    function addLiquidity(uint256 baseAmount, uint256 quoteAmount) external {
        IERC20Like(base).transferFrom(msg.sender, address(this), baseAmount);
        IERC20Like(quote).transferFrom(msg.sender, address(this), quoteAmount);
        reserveBase += baseAmount;
        reserveQuote += quoteAmount;
    }

    /// @return quote per base, 18 decimals
    function spotPrice() external view returns (uint256) {
        return reserveQuote * 1e18 / reserveBase;
    }

    function getAmountOut(address tokenIn, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = tokenIn == base ? (reserveBase, reserveQuote) : (reserveQuote, reserveBase);
        uint256 inWithFee = amountIn * (10_000 - FEE_BPS);
        return inWithFee * rOut / (rIn * 10_000 + inWithFee);
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        require(tokenIn == base || tokenIn == quote, "bad token");
        amountOut = getAmountOut(tokenIn, amountIn);
        require(amountOut >= minOut, "slippage");
        IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == base) {
            reserveBase += amountIn;
            reserveQuote -= amountOut;
            IERC20Like(quote).transfer(to, amountOut);
        } else {
            reserveQuote += amountIn;
            reserveBase -= amountOut;
            IERC20Like(base).transfer(to, amountOut);
        }
        emit Swap(msg.sender, tokenIn, amountIn, amountOut);
    }
}
