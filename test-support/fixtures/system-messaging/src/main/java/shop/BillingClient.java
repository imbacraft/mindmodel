package shop;

import org.springframework.cloud.openfeign.FeignClient;

@FeignClient(name = "billing")
public interface BillingClient {
}
